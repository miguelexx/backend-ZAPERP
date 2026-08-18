/**
 * Retenção de mídia: após MEDIA_RETENTION_DAYS (contados da DATA DA MENSAGEM), apaga o ARQUIVO de
 * mídia — objeto no Cloudflare R2 e/ou arquivo local em /uploads — MANTENDO a mensagem e a conversa
 * no histórico. A bolha passa a mostrar "(mídia expirada)".
 *
 * Segurança:
 *   - DESLIGADO por padrão (MEDIA_RETENTION_DAYS=0/vazio). Só age quando explicitamente configurado.
 *   - Escopo = mesmas empresas do R2 (getR2CompanyIds — hoje só a company 1).
 *   - Apaga APENAS o arquivo; nunca remove o registro da mensagem.
 *   - Idempotente: mensagens já expiradas (storage_backend='expirado', url=null) não voltam à fila.
 *   - Cursor por id: não trava em registros problemáticos. Loga o que expira.
 *
 * IRREVERSÍVEL: uma vez apagado o arquivo, não volta. Por isso o padrão é OFF.
 */

const fs = require('fs')
const path = require('path')
const { getUploadsRoot } = require('../config/uploadsRoot')
const {
  isR2Configured,
  isAllCompaniesR2,
  getR2CompanyIds,
  getMediaRetentionDays,
  getMediaRetentionIntervalMs,
} = require('../config/r2')
const r2 = require('./storage/r2Client')

const MEDIA_TYPES = ['imagem', 'sticker', 'video', 'audio', 'voice', 'arquivo']
const EXPIRADO = 'expirado'
const TEXTO_EXPIRADA = '(mídia expirada)'

/** Caminho absoluto de "/uploads/<nome>" com guarda anti-traversal (idêntico ao do mirror). */
function resolveLocalPath(url) {
  const raw = String(url || '').trim()
  if (!raw.startsWith('/uploads/')) return null
  const root = path.resolve(getUploadsRoot())
  const rel = raw.replace(/^\/uploads\//, '').replace(/^[\\/]+/, '')
  const full = path.resolve(root, decodeURIComponent(rel.split('?')[0]))
  if (full !== root && !full.startsWith(`${root}${path.sep}`)) return null
  return full
}

/** Apaga o(s) arquivo(s) da mensagem (R2 + local) e marca a mensagem como expirada. */
async function expirarMensagem(supabase, row) {
  // 1) Objeto no R2 (se houver). deleteObject trata 204/404 como sucesso idempotente; só lança em
  //    falha real (auth/rede). Nesse caso NÃO marcamos expirada — o próximo ciclo retenta. Assim
  //    evitamos objeto órfão no R2 com a mensagem já marcada como "sem mídia".
  if (row.storage_backend === 'r2' && row.storage_key) {
    try {
      await r2.deleteObject(row.storage_key)
    } catch (e) {
      console.warn('[mediaRetention] deleteObject R2 falhou; adiando esta mensagem:', { id: row.id, erro: e?.message || e })
      return false
    }
  }
  // 2) Arquivo(s) local(is): url atual e url_legado (staging).
  for (const u of [row.url, row.url_legado]) {
    const lp = resolveLocalPath(u)
    if (lp) { try { await fs.promises.unlink(lp) } catch (_) { /* já não existe */ } }
  }
  // 3) Marca a mensagem: mantém id/conversa/tipo/data; zera as referências; rótulo "(mídia expirada)".
  const { error } = await supabase
    .from('mensagens')
    .update({ url: null, storage_backend: EXPIRADO, storage_key: null, url_legado: null, texto: TEXTO_EXPIRADA })
    .eq('id', row.id)
    .eq('company_id', row.company_id)
  return !error
}

/**
 * Varre e expira mídia mais antiga que a retenção. Dois passes (R2 e local), cada um com cursor.
 * @returns {Promise<{ r2: number, local: number, erros: number }>}
 */
async function runMediaRetentionSweep(supabase) {
  const out = { r2: 0, local: 0, erros: 0 }
  const days = getMediaRetentionDays()
  if (!supabase || days <= 0) return out
  if (!isR2Configured()) return out // escopo = empresas em R2 (lista ou "todas")
  const allMode = isAllCompaniesR2()

  const cutoffIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
  const batch = Math.min(500, Math.max(1, Number(process.env.MEDIA_RETENTION_BATCH) || 100))
  const SELECT = 'id, company_id, tipo, url, storage_backend, storage_key, url_legado'

  // Pass genérico com cursor por id. `modo` decide o filtro do arquivo ainda existente.
  async function drenar(modo) {
    let lastId = 0
    for (let i = 0; i < 20000; i += 1) {
      let q = supabase
        .from('mensagens')
        .select(SELECT)
        .in('tipo', MEDIA_TYPES)
        .lt('criado_em', cutoffIso)
        .gt('id', lastId)
        .order('id', { ascending: true })
        .limit(batch)
      if (!allMode) q = q.in('company_id', [...getR2CompanyIds()])
      q = modo === 'r2' ? q.eq('storage_backend', 'r2') : q.like('url', '/uploads/%')

      const { data: rows, error } = await q
      if (error) {
        console.warn(`[mediaRetention/${modo}] query:`, error.message)
        return
      }
      if (!rows || rows.length === 0) return

      for (const row of rows) {
        lastId = Math.max(lastId, Number(row.id))
        try {
          if (await expirarMensagem(supabase, row)) out[modo] += 1
          else out.erros += 1
        } catch (e) {
          out.erros += 1
          console.warn(`[mediaRetention/${modo}] item:`, { id: row.id, erro: e?.message || e })
        }
      }
    }
  }

  await drenar('r2')
  await drenar('local')

  if (out.r2 + out.local > 0) {
    console.log('[mediaRetention] expiradas:', { ...out, retencao_dias: days })
  }
  return out
}

/**
 * Agenda a varredura de retenção (default 24h). No-op se MEDIA_RETENTION_DAYS<=0 ou R2 desligado.
 * @returns {() => void} cancela o intervalo
 */
function startMediaRetentionScheduler(supabase) {
  if (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID) return () => {}
  if (getMediaRetentionDays() <= 0 || !isR2Configured()) return () => {}

  const intervalMs = getMediaRetentionIntervalMs()
  let rodando = false
  const tick = async () => {
    if (rodando) return
    rodando = true
    try {
      const r = await runMediaRetentionSweep(supabase)
      if (r.r2 + r.local > 0) console.log('[mediaRetention] ciclo:', r)
    } catch (e) {
      console.warn('[mediaRetention] tick:', e?.message || e)
    } finally {
      rodando = false
    }
  }

  console.log('[mediaRetention] agendado:', {
    retencao_dias: getMediaRetentionDays(),
    intervalo_h: Math.round(intervalMs / 3600000),
  })
  setImmediate(tick)
  const id = setInterval(tick, intervalMs)
  if (typeof id.unref === 'function') id.unref()
  return () => clearInterval(id)
}

module.exports = {
  runMediaRetentionSweep,
  startMediaRetentionScheduler,
  _test: {
    resolveLocalPath,
    expirarMensagem,
    MEDIA_TYPES,
    EXPIRADO,
    TEXTO_EXPIRADA,
  },
}
