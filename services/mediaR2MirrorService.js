/**
 * Espelha mídia local (/uploads) da empresa habilitada para o Cloudflare R2 e
 * reescreve a referência no banco para servir a partir do R2.
 *
 * Princípios (não derrubar o método antigo):
 *   - Só age sobre empresas habilitadas (empresaUsaR2 — default: só company_id = 1).
 *   - Empresa em R2 = armazenamento ÚNICO: copia para o bucket (verifica) e reescreve a url para
 *     /media/r2/<key>. O arquivo local NÃO é apagado aqui — a purga acontece na varredura de
 *     limpeza (runR2LocalCleanup), após a janela de segurança (opt-out total: R2_KEEP_LOCAL=1).
 *     Nada é apagado antes de o objeto estar confirmado no bucket.
 *   - Idempotente: nunca re-sobe algo já espelhado; reexecutar é seguro.
 *   - Espelha inbound e OUTBOUND imediatamente (ver podeEspelharAgora): a entrega usa a URL /uploads
 *     capturada no envio e o reenvio usa URL assinada do R2, então não é preciso esperar ACK.
 *   - Degrada sem as colunas storage_* (migration não aplicada): apenas não espelha.
 *
 * O mesmo mecanismo migra o histórico existente da empresa: a varredura periódica
 * encontra as mensagens antigas em /uploads e as move para o R2 em lotes.
 */

const fs = require('fs')
const path = require('path')
const { getUploadsRoot } = require('../config/uploadsRoot')
const { empresaUsaR2, keepLocalForever, getLocalCleanupDelayMs } = require('../config/r2')
const r2 = require('./storage/r2Client')

/** Prefixo da rota pública de entrega (302 -> presigned R2). Ver app.js. */
const R2_DELIVERY_PREFIX = '/media/r2/'

const MSG_SELECT =
  'id, conversa_id, company_id, tipo, direcao, status, status_mensagem, url, nome_arquivo, message_timestamp, criado_em, storage_backend, storage_key, url_legado'

/** Uma vez detectado que as colunas não existem, para de tentar espelhar (degrada em silêncio). */
let _colunasStorageIndisponiveis = false

/** Trava em processo: uma mensagem por vez dentro desta instância. */
const emExecucao = new Set()

function isColunaStorageAusente(error) {
  const texto = [error?.message, error?.details, error?.hint, error?.code].filter(Boolean).join(' ').toLowerCase()
  if (!texto) return false
  return (
    texto.includes('storage_backend') ||
    texto.includes('storage_key') ||
    texto.includes('url_legado') ||
    texto.includes('does not exist') ||
    texto.includes('schema cache') ||
    texto.includes('could not find') ||
    texto.includes('42703') ||
    texto.includes('pgrst204')
  )
}

/** Extensão -> MIME para gravar o Content-Type correto no objeto R2. */
const MIME_BY_EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', heic: 'image/heic', heif: 'image/heif',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', avi: 'video/x-msvideo',
  '3gp': 'video/3gpp', m4v: 'video/x-m4v', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', oga: 'audio/ogg',
  opus: 'audio/ogg', wav: 'audio/wav', aac: 'audio/aac', amr: 'audio/amr',
  pdf: 'application/pdf', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain', csv: 'text/csv', xml: 'application/xml', json: 'application/json',
  zip: 'application/zip', rar: 'application/x-rar-compressed', '7z': 'application/x-7z-compressed',
}

function extOf(name) {
  const m = String(name || '').match(/\.([a-z0-9]{2,8})$/i)
  return m ? m[1].toLowerCase() : ''
}

function mimeFromName(name) {
  return MIME_BY_EXT[extOf(name)] || 'application/octet-stream'
}

/** Só estes tipos qualificam para R2 (mídia real). */
function tipoQualifica(tipo) {
  const t = String(tipo || '').toLowerCase()
  return ['imagem', 'sticker', 'video', 'audio', 'voice', 'arquivo'].includes(t)
}

function pastaDoTipo(tipo) {
  const t = String(tipo || '').toLowerCase()
  if (t === 'voice') return 'audio'
  return ['imagem', 'sticker', 'video', 'audio', 'arquivo'].includes(t) ? t : 'outros'
}

/**
 * Espelha assim que a mídia existe em /uploads — inbound e OUTBOUND, sem esperar confirmação do
 * provedor. É seguro porque:
 *  - a ENTREGA usa a URL /uploads capturada no momento do envio (variável local), não a url do banco;
 *  - o REENVIO automático usa URL assinada do R2 (ver urlPublicaDeMidia na reconciliação), então não
 *    depende do arquivo local nem da troca da url;
 *  - o arquivo local é mantido pela janela de segurança antes da purga.
 * Assim o outbound vai para o R2 na hora, independente de ACK/webhook de status.
 */
function podeEspelharAgora(_row) {
  return true
}

/** Caminho absoluto do arquivo local a partir de "/uploads/<nome>" (com guarda anti-traversal). */
function resolveLocalPath(url) {
  const raw = String(url || '').trim()
  if (!raw.startsWith('/uploads/')) return null
  const root = path.resolve(getUploadsRoot())
  const rel = raw.replace(/^\/uploads\//, '').replace(/^[\\/]+/, '')
  const full = path.resolve(root, decodeURIComponent(rel.split('?')[0]))
  if (full !== root && !full.startsWith(`${root}${path.sep}`)) return null
  return full
}

/** Chave do objeto: media/<company>/<ano>/<mes>/<tipo>/<nome-em-disco>. */
function buildStorageKey({ company_id, tipo, criado_em, localFilename }) {
  const d = criado_em ? new Date(criado_em) : new Date()
  const dref = Number.isNaN(d.getTime()) ? new Date() : d
  const ano = dref.getUTCFullYear()
  const mes = String(dref.getUTCMonth() + 1).padStart(2, '0')
  const base = path.basename(String(localFilename || '')).replace(/[^A-Za-z0-9._-]/g, '_')
  return `media/${Number(company_id)}/${ano}/${mes}/${pastaDoTipo(tipo)}/${base}`
}

/**
 * Espelha UMA mensagem para o R2. Idempotente e seguro.
 * @returns {Promise<{ ok: boolean, [k: string]: any }>}
 */
async function mirrorMensagemParaR2({ supabase, io = null, company_id, mensagem_id }) {
  if (_colunasStorageIndisponiveis) return { ok: false, ignorado: 'colunas_ausentes' }
  if (!supabase || !empresaUsaR2(company_id)) return { ok: false, ignorado: 'empresa_nao_habilitada' }

  const chave = `${Number(company_id)}:${Number(mensagem_id)}`
  if (emExecucao.has(chave)) return { ok: false, ignorado: 'em_execucao' }
  emExecucao.add(chave)

  try {
    const { data: row, error } = await supabase
      .from('mensagens')
      .select(MSG_SELECT)
      .eq('id', mensagem_id)
      .eq('company_id', company_id)
      .maybeSingle()

    if (error) {
      if (isColunaStorageAusente(error)) {
        _colunasStorageIndisponiveis = true
        console.warn('[mediaR2] colunas storage_* ausentes; espelhamento desativado. Aplique 20260813120000_mensagens_storage_r2.sql')
      }
      return { ok: false, ignorado: 'erro_leitura' }
    }
    if (!row) return { ok: false, ignorado: 'mensagem_ausente' }
    if (!tipoQualifica(row.tipo)) return { ok: false, ignorado: 'tipo_nao_qualifica' }

    // Já espelhado?
    if (row.storage_backend === 'r2' && row.storage_key) return { ok: true, ignorado: 'ja_espelhado' }
    if (String(row.url || '').startsWith(R2_DELIVERY_PREFIX)) return { ok: true, ignorado: 'ja_espelhado' }

    // Ainda em disco?
    if (!String(row.url || '').startsWith('/uploads/')) return { ok: false, ignorado: 'sem_arquivo_local' }
    if (!podeEspelharAgora(row)) return { ok: false, ignorado: 'status_nao_final' }

    const localPath = resolveLocalPath(row.url)
    if (!localPath || !fs.existsSync(localPath)) return { ok: false, ignorado: 'arquivo_local_inexistente' }

    const localFilename = path.basename(localPath)
    const key = buildStorageKey({
      company_id,
      tipo: row.tipo,
      criado_em: row.message_timestamp || row.criado_em,
      localFilename,
    })
    const contentType = mimeFromName(localFilename)
    const buffer = await fs.promises.readFile(localPath)
    if (!buffer || buffer.length === 0) return { ok: false, ignorado: 'arquivo_vazio' }

    // Upload + verificação de integridade por tamanho.
    await r2.putObject(key, buffer, contentType)
    const head = await r2.headObject(key).catch(() => null)
    if (!head?.exists || (head.size && head.size !== buffer.length)) {
      // Não confia na cópia: remove o objeto parcial e aborta (o arquivo local continua íntegro).
      await r2.deleteObject(key).catch(() => {})
      return { ok: false, ignorado: 'verificacao_falhou' }
    }

    const novaUrl = `${R2_DELIVERY_PREFIX}${key}`
    const { data: updated, error: upErr } = await supabase
      .from('mensagens')
      .update({
        url: novaUrl,
        storage_backend: 'r2',
        storage_key: key,
        url_legado: row.url, // caminho /uploads original: usado pela limpeza p/ purgar e como rollback
      })
      .eq('id', mensagem_id)
      .eq('company_id', company_id)
      .like('url', '/uploads/%') // só troca se ninguém já migrou (evita corrida/duplicidade)
      .select(MSG_SELECT)
      .maybeSingle()

    if (upErr) {
      if (isColunaStorageAusente(upErr)) _colunasStorageIndisponiveis = true
      // objeto no R2 fica órfão inofensivo; a varredura tenta de novo depois.
      console.warn('[mediaR2] update DB falhou:', { mensagem_id, erro: upErr.message })
      return { ok: false, ignorado: 'update_db' }
    }
    if (!updated) {
      // Outra tentativa já migrou: o objeto que subimos é duplicata órfã.
      await r2.deleteObject(key).catch(() => {})
      return { ok: true, ignorado: 'ja_espelhado' }
    }

    // R2 é o armazenamento de registro (a url já aponta para o R2). O arquivo local de staging
    // NÃO é apagado imediatamente: para imagem/documento a UltraMSG pode ainda estar baixando a
    // mídia enviada por URL pública. A purga acontece após a janela de segurança por DOIS caminhos
    // redundantes: (1) um timer por-arquivo agendado aqui (não depende do scheduler periódico) e
    // (2) a varredura runR2LocalCleanup (restart-safe). url_legado preserva o caminho até a purga.
    console.log('[mediaR2] mídia copiada para R2', {
      mensagem_id, company_id, tipo: row.tipo, key, bytes: buffer.length,
      local_purga: keepLocalForever() ? 'nunca (R2_KEEP_LOCAL)' : `em ~${Math.round(getLocalCleanupDelayMs() / 60000)}min`,
    })

    agendarPurgaLocal({ supabase, company_id, mensagem_id, localPath })
    emitirMidiaAtualizada({ io, company_id, row, updated })
    return { ok: true, url: novaUrl, key }
  } catch (e) {
    console.warn('[mediaR2] falha ao espelhar:', { mensagem_id, company_id, erro: e?.message || String(e) })
    return { ok: false, ignorado: 'excecao', erro: e?.message || String(e) }
  } finally {
    emExecucao.delete(chave)
  }
}

function emitirMidiaAtualizada({ io, company_id, row, updated }) {
  if (!io) return
  try {
    const conversa_id = updated.conversa_id ?? row.conversa_id
    const fromMe = String(updated.direcao ?? row.direcao ?? '').toLowerCase() === 'out'
    const payload = { ...updated, conversa_id, fromMe }
    io.to(`conversa_${conversa_id}`).emit(io.EVENTS?.NOVA_MENSAGEM || 'nova_mensagem', payload)
  } catch (_) { /* emissão é best-effort */ }
}

/** Agenda espelhamento assíncrono (não bloqueia o fluxo). No-op se a empresa não usa R2. */
function scheduleR2MirrorIfNeeded({ supabase, io = null, company_id, mensagem_id }) {
  if (_colunasStorageIndisponiveis) return
  if (!supabase || company_id == null || mensagem_id == null) return
  if (!empresaUsaR2(company_id)) return
  setImmediate(() => {
    mirrorMensagemParaR2({ supabase, io, company_id, mensagem_id }).catch((e) => {
      console.warn('[mediaR2] agendamento falhou:', { mensagem_id, erro: e?.message || String(e) })
    })
  })
}

/**
 * Varredura em lote: migra mídia da(s) empresa(s) habilitada(s) ainda em /uploads.
 * Cobre outbound pós-envio e o HISTÓRICO existente. Idempotente e retomável (cursor por id).
 */
async function runMediaR2MirrorSweep(supabase, io = null) {
  const out = { scanned: 0, mirrored: 0, skipped: 0, motivos: {} }
  if (_colunasStorageIndisponiveis || !supabase) { out.motivos.colunas_indisponiveis = 1; return out }
  const { getR2CompanyIds, isR2Configured } = require('../config/r2')
  if (!isR2Configured()) return out

  const companyIds = [...getR2CompanyIds()]
  if (!companyIds.length) return out

  const batch = Math.min(500, Math.max(1, Number(process.env.R2_MIRROR_BATCH) || 100))

  const { data: rows, error } = await supabase
    .from('mensagens')
    .select('id, company_id')
    .in('company_id', companyIds)
    .is('storage_key', null)
    .like('url', '/uploads/%')
    .order('id', { ascending: true })
    .limit(batch)

  if (error) {
    if (isColunaStorageAusente(error)) {
      _colunasStorageIndisponiveis = true
      console.warn('[mediaR2/sweep] colunas storage_* ausentes; varredura desativada.')
    } else {
      console.warn('[mediaR2/sweep] query:', error.message)
    }
    return out
  }

  for (const r of rows || []) {
    out.scanned += 1
    try {
      const res = await mirrorMensagemParaR2({ supabase, io, company_id: r.company_id, mensagem_id: r.id })
      if (res?.ok && res?.key) out.mirrored += 1
      else {
        out.skipped += 1
        const m = res?.ignorado || (res?.erro ? 'excecao' : 'desconhecido')
        out.motivos[m] = (out.motivos[m] || 0) + 1
      }
    } catch (e) {
      out.skipped += 1
      out.motivos.excecao = (out.motivos.excecao || 0) + 1
      console.warn('[mediaR2/sweep] item:', { mensagem_id: r.id, erro: e?.message || e })
    }
  }
  return out
}

/** Remove o arquivo local e zera url_legado (marca como purgado). Idempotente. */
async function purgarLocalDeMensagem(supabase, company_id, mensagem_id, localPath) {
  try {
    if (localPath) { try { await fs.promises.unlink(localPath) } catch (_) { /* já removido */ } }
    if (supabase) {
      await supabase.from('mensagens').update({ url_legado: null }).eq('id', mensagem_id).eq('company_id', company_id)
    }
    return true
  } catch (e) {
    console.warn('[mediaR2] purga local falhou:', { mensagem_id, erro: e?.message || e })
    return false
  }
}

/**
 * Agenda a purga do arquivo local após a janela de segurança, POR ARQUIVO — não depende do
 * scheduler periódico rodar neste processo. unref: não segura o processo vivo. A varredura
 * runR2LocalCleanup continua como backstop restart-safe (o timer morre se o processo reiniciar).
 */
function agendarPurgaLocal({ supabase, company_id, mensagem_id, localPath }) {
  if (keepLocalForever()) return
  const delay = getLocalCleanupDelayMs()
  const t = setTimeout(() => {
    purgarLocalDeMensagem(supabase, company_id, mensagem_id, localPath).catch(() => {})
  }, delay)
  if (typeof t.unref === 'function') t.unref()
}

/**
 * Purga arquivos locais de staging já copiados ao R2, depois da janela de segurança.
 * É o que efetiva "armazenar apenas no R2": o objeto já está no bucket (storage_backend='r2'),
 * e passado o tempo suficiente para a UltraMSG ter baixado mídia enviada por URL pública,
 * o /uploads é removido e url_legado é zerado (não reprocessa). Restart-safe e idempotente.
 */
async function runR2LocalCleanup(supabase) {
  const out = { checked: 0, purged: 0 }
  if (_colunasStorageIndisponiveis || !supabase || keepLocalForever()) return out
  const { getR2CompanyIds, isR2Configured } = require('../config/r2')
  if (!isR2Configured()) return out
  const companyIds = [...getR2CompanyIds()]
  if (!companyIds.length) return out

  const cutoffIso = new Date(Date.now() - getLocalCleanupDelayMs()).toISOString()
  const batch = Math.min(500, Math.max(1, Number(process.env.R2_CLEANUP_BATCH) || 200))

  const { data: rows, error } = await supabase
    .from('mensagens')
    .select('id, company_id, url_legado')
    .in('company_id', companyIds)
    .eq('storage_backend', 'r2')
    .like('url_legado', '/uploads/%')
    .lt('criado_em', cutoffIso)
    .order('id', { ascending: true })
    .limit(batch)

  if (error) {
    if (isColunaStorageAusente(error)) { _colunasStorageIndisponiveis = true; return out }
    console.warn('[mediaR2/cleanup] query:', error.message)
    return out
  }

  for (const r of rows || []) {
    out.checked += 1
    const local = resolveLocalPath(r.url_legado)
    if (await purgarLocalDeMensagem(supabase, r.company_id, r.id, local)) out.purged += 1
  }

  if (out.purged > 0) console.log('[mediaR2/cleanup]', out)
  return out
}

/**
 * Migração COMPLETA do histórico: drena todo o backlog de /uploads → R2 (em lotes, do mais antigo
 * ao mais novo) e depois libera o espaço purgando o staging local já confirmado no R2.
 * Idempotente e não-destrutivo (a url só troca após upload verificado; o local só é apagado depois
 * de o objeto estar no bucket). Serve ao gatilho de boot (R2_MIGRATE_HISTORICO_ON_BOOT=1).
 */
async function runFullHistoryMigration(supabase, io = null, { maxLotes = 10000 } = {}) {
  const { isR2Configured, getR2CompanyIds } = require('../config/r2')
  if (!supabase || !isR2Configured()) {
    console.warn('[mediaR2/historico] R2 não configurado ou supabase ausente — migração não executada.')
    return { migradas: 0, purgadas: 0 }
  }

  // Reseta a flag de "colunas ausentes": um erro transitório anterior neste processo poderia
  // tê-la ligado e deixado a varredura retornar cedo (0 migradas). Migração é ação deliberada.
  _colunasStorageIndisponiveis = false

  const companyIds = [...getR2CompanyIds()]
  const batch = Math.min(500, Math.max(1, Number(process.env.R2_MIGRATE_BATCH) || 100))

  console.log('[mediaR2/historico] iniciando migração completa do histórico para o R2…', { companyIds, batch })

  // CURSOR por id: avança por TODAS as candidatas, inclusive as que não têm arquivo local (que
  // ficam com storage_key null). Sem cursor, as mais antigas sem arquivo bloqueariam a fila
  // (a query sempre devolveria as mesmas primeiro) e a migração pararia no 1º lote.
  let lastId = 0
  const total = { lidas: 0, migradas: 0, ausentes: 0, ja_no_r2: 0, outros: 0 }

  for (let i = 0; i < maxLotes; i += 1) {
    const { data: rows, error } = await supabase
      .from('mensagens')
      .select('id, company_id')
      .in('company_id', companyIds)
      .is('storage_key', null)
      .like('url', '/uploads/%')
      .gt('id', lastId)
      .order('id', { ascending: true })
      .limit(batch)

    if (error) {
      console.warn('[mediaR2/historico] query falhou:', error.message)
      break
    }
    if (!rows || rows.length === 0) break

    for (const r of rows) {
      total.lidas += 1
      lastId = Math.max(lastId, Number(r.id))
      let res
      try {
        res = await mirrorMensagemParaR2({ supabase, io, company_id: r.company_id, mensagem_id: r.id })
      } catch (e) {
        res = { ok: false, ignorado: 'excecao', erro: e?.message || String(e) }
      }
      if (res.ok && res.key) total.migradas += 1
      else if (res.ignorado === 'ja_espelhado') total.ja_no_r2 += 1
      else if (res.ignorado === 'arquivo_local_inexistente') total.ausentes += 1
      else total.outros += 1
    }

    if (i % 5 === 0) console.log('[mediaR2/historico] progresso:', { ...total, lastId })
  }

  console.log('[mediaR2/historico] cópia concluída:', total)

  // Libera o espaço: purga o staging local já no R2 (respeita a janela de segurança).
  let purgadas = 0
  for (let i = 0; i < maxLotes; i += 1) {
    const r = await runR2LocalCleanup(supabase)
    purgadas += r.purged || 0
    if ((r.purged || 0) === 0) break
  }
  console.log('[mediaR2/historico] limpeza concluída. Arquivos locais purgados:', purgadas)
  return { migradas: total.migradas, ausentes: total.ausentes, purgadas }
}

/**
 * Agenda a varredura periódica (default: 5min). Desligar: R2_MIRROR_DISABLED=1.
 * @returns {() => void} cancela o intervalo
 */
function startMediaR2MirrorScheduler(supabase, io = null) {
  if (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID) return () => {}
  if (String(process.env.R2_MIRROR_DISABLED || '').trim() === '1') return () => {}
  const { isR2Configured } = require('../config/r2')
  if (!isR2Configured()) return () => {}

  const intervalMs = Math.max(60 * 1000, Number(process.env.R2_MIRROR_INTERVAL_MS) || 5 * 60 * 1000)

  let rodando = false
  const tick = async () => {
    if (rodando) return
    rodando = true
    try {
      const r = await runMediaR2MirrorSweep(supabase, io)
      if (r.mirrored > 0) console.log('[mediaR2/sweep]', r)
      // Purga o staging local já copiado ao R2 (após a janela de segurança).
      await runR2LocalCleanup(supabase)
    } catch (e) {
      console.warn('[mediaR2/sweep] tick', e?.message || e)
    } finally {
      rodando = false
    }
  }

  setImmediate(tick)
  const id = setInterval(tick, intervalMs)
  if (typeof id.unref === 'function') id.unref()
  return () => clearInterval(id)
}

module.exports = {
  mirrorMensagemParaR2,
  scheduleR2MirrorIfNeeded,
  runMediaR2MirrorSweep,
  runR2LocalCleanup,
  runFullHistoryMigration,
  startMediaR2MirrorScheduler,
  _test: {
    buildStorageKey,
    pastaDoTipo,
    podeEspelharAgora,
    resolveLocalPath,
    mimeFromName,
    tipoQualifica,
    resetColunasFlag: () => { _colunasStorageIndisponiveis = false },
    setColunasFlag: (v) => { _colunasStorageIndisponiveis = !!v },
  },
}
