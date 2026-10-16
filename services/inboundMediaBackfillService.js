/**
 * Backfill automático de mídia recebida SEM URL no webhook.
 *
 * Cenário comprovado (payload real): instâncias UltraMsg com webhook_message_download_media
 * ineficaz entregam `message_received` de áudio/imagem com `media:""` — a URL nunca chega por
 * webhook. Porém o `GET /chats/messages` (mesmo endpoint do botão "Carregar mensagens antigas")
 * RETORNA a mídia. Este serviço dispara esse fetch em background quando uma mensagem de mídia é
 * gravada sem URL, reparando a linha (via a lógica de reparo do oldMessagesSyncService) em segundos,
 * sem ação do atendente.
 *
 * Proteções para tráfego intenso:
 *  - debounce por conversa (default 60s) — vários áudios seguidos disparam 1 fetch só;
 *  - passada de arrasto (trailing) ao fim do debounce — garante o último áudio da rajada;
 *  - teto global de execuções concorrentes;
 *  - desligável por env INBOUND_MEDIA_BACKFILL_DISABLED=1.
 */

const MEDIA_FAMILY_TIPOS = new Set(['voice', 'audio', 'imagem', 'video', 'sticker', 'arquivo'])
const MEDIA_PLACEHOLDER_TEXTS = new Set([
  '(mensagem)', '(mídia)', '(midia)', '(imagem)', '(áudio)', '(audio)', '(áudio de voz)',
  '(vídeo)', '(video)', '(vídeo visualização única)', '(figurinha)', '(sticker)', '(arquivo)', '(documento)',
])

function parsePositiveIntEnv(name, fallback, { min, max }) {
  const n = Number(process.env[name])
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.floor(n)))
}

function isBackfillDisabled() {
  return String(process.env.INBOUND_MEDIA_BACKFILL_DISABLED || '').trim() === '1'
}

function debounceMs() {
  return parsePositiveIntEnv('INBOUND_MEDIA_BACKFILL_DEBOUNCE_MS', 60_000, { min: 5_000, max: 600_000 })
}

function trailingMs() {
  return parsePositiveIntEnv('INBOUND_MEDIA_BACKFILL_TRAILING_MS', 8_000, { min: 1_000, max: 60_000 })
}

function maxConcurrent() {
  return parsePositiveIntEnv('INBOUND_MEDIA_BACKFILL_MAX_CONCURRENT', 3, { min: 1, max: 20 })
}

/** URL renderável já presente? (https remota ou /uploads local) */
function hasUsableMediaUrl(url) {
  const u = String(url || '').trim()
  return u.startsWith('https://') || u.startsWith('http://') || u.startsWith('/uploads/')
}

/** Tipos de mídia do webhook (nomenclatura do provider) → vale a pena buscar o arquivo. */
const MEDIA_FAMILY_WEBHOOK_TYPES = new Set([
  'image', 'imagem', 'audio', 'ptt', 'voice', 'video', 'vídeo', 'gif', 'short',
  'document', 'file', 'arquivo', 'documento', 'sticker', 'figurinha',
])

/**
 * Decide se uma mensagem gravada precisa de backfill de mídia.
 * true quando: sem URL renderável E (tipo de mídia OU texto é placeholder de mídia/genérico OU o
 * webhook disse que era mídia).
 *
 * `tipoWebhook` existe porque a mídia COM LEGENDA perde todo o rastro na linha gravada: a legenda
 * vira o texto (não é placeholder) e, sem URL, nenhum ramo de `applyInboundMediaFields` casa — o
 * tipo fica no default 'texto'. Sem essa dica, uma foto legendada que chegou sem link nunca seria
 * buscada de volta e a imagem se perdia em silêncio.
 *
 * @param {{ tipo?: string, texto?: string, url?: string }} msg
 * @param {string} [tipoWebhook] tipo cru do webhook (image/audio/video/document/sticker/...)
 */
function precisaBackfillMidia(msg, tipoWebhook) {
  if (!msg) return false
  if (hasUsableMediaUrl(msg.url)) return false
  const tipo = String(msg.tipo || '').toLowerCase().trim()
  if (MEDIA_FAMILY_TIPOS.has(tipo)) return true
  const texto = String(msg.texto || '').trim().toLowerCase()
  if (MEDIA_PLACEHOLDER_TEXTS.has(texto)) return true
  return MEDIA_FAMILY_WEBHOOK_TYPES.has(String(tipoWebhook || '').toLowerCase().trim())
}

// chave → { lastTs, trailingTimer }
const _debounceMap = new Map()
let _running = 0

// Limpeza periódica de entradas expiradas no mapa de debounce.
setInterval(() => {
  const cutoff = Date.now() - debounceMs() * 2
  for (const [key, entry] of _debounceMap.entries()) {
    if (entry.lastTs < cutoff && !entry.trailingTimer) _debounceMap.delete(key)
  }
}, 5 * 60 * 1000).unref()

/** @returns {Promise<boolean>} true quando chegou a chamar o provedor; false se o teto global barrou. */
async function executarBackfill({ supabase, io, company_id, conversa_id }) {
  if (_running >= maxConcurrent()) return false
  _running += 1
  try {
    const { syncOldMessagesForConversation } = require('./oldMessagesSyncService')
    const res = await syncOldMessagesForConversation(company_id, Number(conversa_id), {
      io: io || null,
      source: 'inbound_media_backfill',
    }).catch((e) => ({ ok: false, error: e?.message || String(e) }))
    const changed = (res?.messagesUpdated || 0) + (res?.messagesInserted || 0)
    if (changed > 0) {
      console.log('[inboundMediaBackfill] mídia recuperada via GET /chats/messages', {
        company_id, conversa_id, atualizadas: res.messagesUpdated || 0, inseridas: res.messagesInserted || 0,
      })
    }
  } catch (e) {
    console.warn('[inboundMediaBackfill] falha', { conversa_id, err: e?.message || String(e) })
  } finally {
    _running -= 1
  }
  return true
}

/**
 * Agenda (não bloqueia o webhook) um backfill de mídia para a conversa, se necessário.
 *
 * Estratégia: trailing-debounce por conversa.
 * - 1 áudio: dispara após trailingMs (dá tempo do provedor liberar a URL na API).
 * - Rajada: cada nova mensagem reinicia o timer; dispara 1x ao fim da rajada.
 * - Se já há maxConcurrent em execução, pula silenciosamente (a mídia será reparada
 *   pelo sweep periódico do inboundMediaPersistenceService se necessário).
 *
 * @param {{ supabase:any, io:any, company_id:number, conversa_id:number, mensagemSalva:object,
 *   tipoWebhook?:string }} ctx
 */
function scheduleInboundMediaBackfill(ctx) {
  const { supabase, io, company_id, conversa_id, mensagemSalva, tipoWebhook } = ctx || {}
  if (isBackfillDisabled()) return
  if (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID) return
  if (company_id == null || conversa_id == null) return
  if (!precisaBackfillMidia(mensagemSalva, tipoWebhook)) return

  const key = `${company_id}:${conversa_id}`
  const now = Date.now()
  const entry = _debounceMap.get(key) || { lastTs: 0, trailingTimer: null }

  // Reinicia o timer a cada nova mensagem (trailing).
  if (entry.trailingTimer) clearTimeout(entry.trailingTimer)
  entry.lastTs = now
  _debounceMap.set(key, entry)

  if (_running >= maxConcurrent()) return

  const trailing = trailingMs()
  entry.trailingTimer = setTimeout(() => {
    entry.trailingTimer = null
    setImmediate(() => executarBackfill({ supabase, io, company_id, conversa_id }))
  }, trailing)
  if (typeof entry.trailingTimer.unref === 'function') entry.trailingTimer.unref()
}

// ─────────────────────────────────────────────────────────────────────────────
// Varredura periódica da mídia SEM URL.
//
// Por que existe: `scheduleInboundMediaBackfill` guarda o agendamento só na MEMÓRIA do processo
// (_debounceMap + setTimeout, 8–60s). Um restart nessa janela — deploy, PM2, crash — mata o
// agendamento e NADA o substituía: as duas varreduras do inboundMediaPersistenceService exigem
// `midia_persist_status = PENDENTE` ou `url LIKE 'https%'`, e a linha sem URL não tem nem um nem
// outro. O único caminho restante era o atendente clicar em "buscar" na bolha. Auditoria de
// 16/10/2026: foi assim que se formou boa parte do passivo de mídia quebrada.
//
// Custo: cada conversa custa UMA chamada de histórico ao provedor. A contenção é em camadas —
// janela do provedor, teto de conversas por ciclo, pausa entre elas, cooldown por conversa e o
// mesmo teto de concorrência global do backfill ao vivo.
// ─────────────────────────────────────────────────────────────────────────────

/** conversa → quando pode ser varrida de novo. Em memória: um restart custa no máximo 1 passada extra. */
const _sweepCooldown = new Map()

function sweepDisabled() {
  return isBackfillDisabled() || String(process.env.INBOUND_MEDIA_NOURL_SWEEP_DISABLED || '').trim() === '1'
}

function sweepIntervalMs() {
  return parsePositiveIntEnv('INBOUND_MEDIA_NOURL_SWEEP_INTERVAL_MS', 15 * 60_000, { min: 60_000, max: 6 * 3600_000 })
}

/** Janela do provedor: fora dela não há o que buscar (Whapi devolve ~45 dias). */
function sweepJanelaDias() {
  return parsePositiveIntEnv('INBOUND_MEDIA_NOURL_SWEEP_JANELA_DIAS', 45, { min: 1, max: 365 })
}

function sweepMaxConversas() {
  return parsePositiveIntEnv('INBOUND_MEDIA_NOURL_SWEEP_MAX_CONVERSAS', 20, { min: 1, max: 200 })
}

function sweepCooldownMs() {
  return parsePositiveIntEnv('INBOUND_MEDIA_NOURL_SWEEP_COOLDOWN_MS', 6 * 3600_000, { min: 60_000, max: 7 * 24 * 3600_000 })
}

function sweepPausaMs() {
  return parsePositiveIntEnv('INBOUND_MEDIA_NOURL_SWEEP_PAUSA_MS', 1500, { min: 0, max: 60_000 })
}

/**
 * PURA: decide quais conversas a varredura vai tocar nesta rodada.
 * Agrupa as linhas quebradas por (empresa, conversa), descarta o que está em cooldown e corta no
 * teto. Ordena pela linha mais recente primeiro — mídia nova é a que o atendimento ainda precisa.
 *
 * @param {Array<{id:number, company_id:number, conversa_id:number, tipo?:string, texto?:string, url?:string, criado_em?:string}>} rows
 * @param {{ agora?:number, cooldown?:Map<string,number>, maxConversas?:number }} opts
 * @returns {Array<{ company_id:number, conversa_id:number, linhas:number, maisRecente:number }>}
 */
function selecionarConversasParaVarredura(rows, opts = {}) {
  const agora = Number.isFinite(opts.agora) ? opts.agora : Date.now()
  const cooldown = opts.cooldown instanceof Map ? opts.cooldown : new Map()
  const max = Number.isFinite(opts.maxConversas) ? opts.maxConversas : sweepMaxConversas()

  const porConversa = new Map()
  for (const row of rows || []) {
    if (!precisaBackfillMidia(row)) continue
    const companyId = Number(row?.company_id)
    const conversaId = Number(row?.conversa_id)
    if (!Number.isFinite(companyId) || companyId <= 0) continue
    if (!Number.isFinite(conversaId) || conversaId <= 0) continue

    const chave = `${companyId}:${conversaId}`
    const liberadaEm = cooldown.get(chave)
    if (liberadaEm != null && liberadaEm > agora) continue

    const ts = Date.parse(row?.criado_em || '') || 0
    const atual = porConversa.get(chave)
    if (atual) {
      atual.linhas += 1
      if (ts > atual.maisRecente) atual.maisRecente = ts
    } else {
      porConversa.set(chave, { company_id: companyId, conversa_id: conversaId, linhas: 1, maisRecente: ts })
    }
  }

  return [...porConversa.values()]
    .sort((a, b) => b.maisRecente - a.maisRecente)
    .slice(0, max)
}

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve())

/**
 * Uma passada da varredura. Cross-company de propósito, igual aos schedulers de mídia que já
 * existem (inboundMediaPersistenceService): a query traz `company_id` e cada item é tratado com o
 * company_id da PRÓPRIA linha — nenhuma query de negócio roda sem empresa explícita.
 *
 * @returns {Promise<{ candidatas:number, varridas:number, reparadas:number }>}
 */
async function runInboundMediaNoUrlSweep(supabase, io = null) {
  const out = { candidatas: 0, varridas: 0 }
  if (!supabase || sweepDisabled()) return out

  const sinceIso = new Date(Date.now() - sweepJanelaDias() * 24 * 3600_000).toISOString()
  // Teto de linhas lidas: o agrupamento por conversa reduz muito, mas a leitura precisa de limite.
  const limiteLinhas = Math.min(2000, sweepMaxConversas() * 25)

  // ATENÇÃO: `url IS NULL` sozinho NÃO seleciona mídia quebrada — a coluna `url` não tem default e
  // só os ramos de mídia a preenchem, então TODA mensagem de texto, nota interna e reação também
  // tem url nula. Filtrar só por ela traria as mensagens mais recentes da plataforma (quase todas
  // texto), estouraria o limite com lixo e a mídia quebrada de ontem nunca entraria na janela.
  // Por isso o recorte de mídia vai no SQL, em duas consultas: pelo TIPO (áudio gravado com tipo
  // real) e pelo TEXTO de placeholder (foto/vídeo/documento, que ficam com tipo 'texto' quando a
  // URL não vem). `.in()` deixa o escape dos acentos com o client.
  //
  // LIMITE CONHECIDO: mídia sem URL que veio COM legenda (ou documento com nome de arquivo) grava
  // a legenda no texto e tipo 'texto' — não sobra nenhuma marca na linha e nenhuma varredura
  // conseguiria achá-la. Esse caso depende do backfill ao vivo, que recebe o tipo do webhook como
  // dica (`tipoWebhook`). Só se perde quando a API reinicia dentro da janela de debounce.
  const base = () => supabase
    .from('mensagens')
    .select('id, company_id, conversa_id, tipo, texto, url, criado_em')
    .is('url', null)
    // Sem whatsapp_id o reparo não tem como casar a linha com a do histórico: varrer seria gastar
    // cota do provedor à toa.
    .not('whatsapp_id', 'is', null)
    .gte('criado_em', sinceIso)
    .order('criado_em', { ascending: false })
    .limit(limiteLinhas)

  const [porTipo, porPlaceholder] = await Promise.all([
    base().in('tipo', [...MEDIA_FAMILY_TIPOS]),
    base().in('texto', [...MEDIA_PLACEHOLDER_TEXTS]),
  ])

  const erro = porTipo.error || porPlaceholder.error
  if (erro) {
    console.warn('[inboundMediaNoUrlSweep] query:', erro.message)
    return out
  }

  // União por id: uma linha pode casar nos dois recortes (tipo 'audio' com texto '(áudio)').
  const porId = new Map()
  for (const row of [...(porTipo.data || []), ...(porPlaceholder.data || [])]) {
    if (row && row.id != null) porId.set(row.id, row)
  }

  const alvos = selecionarConversasParaVarredura([...porId.values()], { cooldown: _sweepCooldown })
  out.candidatas = alvos.length
  if (alvos.length === 0) return out

  const cooldown = sweepCooldownMs()
  const pausa = sweepPausaMs()
  for (const alvo of alvos) {
    // Devolve false quando o teto global de concorrência barrou: não houve chamada ao provedor.
    const rodou = await executarBackfill({
      supabase, io, company_id: alvo.company_id, conversa_id: alvo.conversa_id,
    })
    if (!rodou) continue // nada gasto: a conversa fica livre para a próxima rodada
    // Cooldown só depois de gastar uma chamada: é o que impede martelar toda rodada a conversa
    // que está na janela mas cujo arquivo o provedor já perdeu. Falha do provedor também marca —
    // insistir de 15 em 15 min no mesmo erro é justamente o que queremos evitar.
    _sweepCooldown.set(`${alvo.company_id}:${alvo.conversa_id}`, Date.now() + cooldown)
    out.varridas += 1
    await sleep(pausa)
  }

  // Limpeza do cooldown vencido (o mapa não pode crescer sem fim).
  const agora = Date.now()
  for (const [chave, liberadaEm] of _sweepCooldown.entries()) {
    if (liberadaEm <= agora) _sweepCooldown.delete(chave)
  }

  if (out.varridas > 0) {
    console.log('[inboundMediaNoUrlSweep] passada concluída', {
      candidatas: out.candidatas, varridas: out.varridas, janela_dias: sweepJanelaDias(),
    })
  }
  return out
}

/**
 * Liga a varredura periódica. No-op em teste e quando desligada por env.
 * @returns {() => void} cancela o intervalo
 */
function startInboundMediaNoUrlSweepScheduler(supabase, io) {
  if (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID) return () => {}
  if (sweepDisabled()) return () => {}
  const intervalo = sweepIntervalMs()
  const timer = setInterval(() => {
    runInboundMediaNoUrlSweep(supabase, io).catch((e) => {
      console.warn('[inboundMediaNoUrlSweep] falha na passada:', e?.message || e)
    })
  }, intervalo)
  if (typeof timer.unref === 'function') timer.unref()
  console.log(`[inboundMediaNoUrlSweep] varredura de mídia sem URL ativa (a cada ${Math.round(intervalo / 60_000)} min)`)
  return () => clearInterval(timer)
}

module.exports = {
  scheduleInboundMediaBackfill,
  precisaBackfillMidia,
  hasUsableMediaUrl,
  runInboundMediaNoUrlSweep,
  startInboundMediaNoUrlSweepScheduler,
  _test: {
    selecionarConversasParaVarredura,
    _sweepCooldown,
  },
}
