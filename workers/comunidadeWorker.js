/**
 * Worker de Comunidades — processa a fila de participantes de forma ULTRA-CONSERVADORA
 * para reduzir ao máximo o risco de limitação/bloqueio do número WhatsApp.
 *
 * Proteções:
 *  - 1 item por vez (batchSize=1), advisory lock por instância (serializa a instância);
 *  - intervalo variável com jitter entre operações (ex. 30–60s);
 *  - teto por hora e por dia por instância (metadata.comunidade_limites, configurável);
 *  - backoff exponencial em erro temporário; PAUSA automática da operação em 429/rate limit;
 *  - 'failed' da Whapi (anti-spam) é terminal, sem retry infinito;
 *  - lease + recuperação de leases expirados (crash-safe), idempotência por item.
 *
 * Embutido no index.js via startComunidadeWorker(io). Também roda standalone (PM2).
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })

const os = require('os')
const supabase = require('../config/supabase')
const { getProvider } = require('../services/providers')
const { getWhatsappInstanceById } = require('../services/whatsappInstanceService')
const { classificarErro, calcularProximaTentativa } = require('../helpers/disparoFilaRetryHelper')
const {
  getComunidadeWorkerConfig,
  resolverLimitesInstancia,
  intervaloComJitterMs,
} = require('../helpers/comunidadeWorkerConfig')
const {
  recalcularContadores,
  pausarOperacaoAutomatica,
} = require('../services/comunidade/comunidadeFilaService')
const { emitComunidade, EVENTS } = require('../services/comunidade/comunidadeSocketService')
const { resolverEnderecoWhatsapp } = require('../services/chat/identity/enderecoWhatsappService')
const { isSameWhatsappIdentity } = require('../helpers/phoneHelper')

const cfg = getComunidadeWorkerConfig()
let io = null
let shuttingDown = false
let loopTimer = null
let processing = false
let started = false

/** Próximo horário permitido por instância (ms epoch) — espaçamento conservador em processo. */
const proximoPermitidoPorInstancia = new Map()
/** Cache curto de metadata/limites por instância. */
const limitesCache = new Map() // instId -> { limites, at }
const LIMITES_TTL_MS = 60000

function provider() {
  return getProvider({ provider: 'whapi' })
}

async function limitesDaInstancia(companyId, instId) {
  const cached = limitesCache.get(instId)
  if (cached && Date.now() - cached.at < LIMITES_TTL_MS) return cached.limites
  let metadata = null
  try {
    const r = await getWhatsappInstanceById(companyId, instId, { includeCredentials: false, requireActive: false })
    metadata = r?.instance?.metadata || null
  } catch { /* usa default */ }
  const limites = resolverLimitesInstancia(metadata)
  limitesCache.set(instId, { limites, at: Date.now() })
  return limites
}

/**
 * O número está conectado? Enquanto não estiver, o worker NÃO toca na fila.
 *
 * Em 11/11/2026 o canal da empresa 4 caiu para `QR` no meio de uma leva de adições. O worker
 * continuou chamando o provedor: cada chamada gastava uma das 5 tentativas do item e voltava
 * vazia, e o item terminava marcado como falha por um motivo que não era dele. Pior: tentativa
 * de adicionar em grupo é a operação de maior risco anti-spam justamente quando a sessão está
 * instável. Com a guarda, o item é adiado e espera o número voltar.
 *
 * `null`/erro = não deu para saber → deixa passar (indisponibilidade de leitura não pode
 * paralisar a fila de quem está saudável).
 */
async function instanciaConectada(companyId, instId) {
  try {
    const r = await getWhatsappInstanceById(companyId, instId, { includeCredentials: false, requireActive: false })
    const status = String(r?.instance?.status || '').trim().toLowerCase()
    if (!status) return true
    return status === 'connected' || status === 'authenticated' || status === 'auth'
  } catch {
    return true
  }
}

/** Conta adições concluídas da instância numa janela (segundos atrás → agora). */
async function contarConcluidosJanela(companyId, instId, segundos) {
  const desde = new Date(Date.now() - segundos * 1000).toISOString()
  const { count } = await supabase
    .from('comunidade_fila_itens')
    .select('*', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('whatsapp_instance_id', instId)
    .eq('status', 'concluida')
    .gte('concluido_em', desde)
  return Number(count) || 0
}

/**
 * Gate de ritmo. Retorna { ok } ou { ok:false, esperaMs, motivo }.
 * Verifica: espaçamento em processo, teto/hora e teto/dia.
 */
async function gateDeRitmo(companyId, instId, limites) {
  const agora = Date.now()
  const prox = proximoPermitidoPorInstancia.get(instId) || 0
  if (agora < prox) {
    return { ok: false, esperaMs: prox - agora, motivo: 'intervalo' }
  }
  if (limites.porHora > 0) {
    const h = await contarConcluidosJanela(companyId, instId, 3600)
    if (h >= limites.porHora) return { ok: false, esperaMs: 15 * 60 * 1000, motivo: 'limite_hora' }
  }
  if (limites.porDia > 0) {
    const d = await contarConcluidosJanela(companyId, instId, 86400)
    if (d >= limites.porDia) return { ok: false, esperaMs: 60 * 60 * 1000, motivo: 'limite_dia' }
  }
  return { ok: true }
}

async function tryLockInstancia(instId) {
  try {
    const { data, error } = await supabase.rpc('comunidade_try_lock_instancia', { p_instancia_id: instId })
    if (error) { console.warn('[comunidadeWorker] lock:', error.message); return false }
    return data === true
  } catch (e) { console.warn('[comunidadeWorker] lock exc:', e?.message); return false }
}

async function unlockInstancia(instId) {
  try { await supabase.rpc('comunidade_unlock_instancia', { p_instancia_id: instId }) } catch { /* noop */ }
}

async function recuperarLeases() {
  try {
    const { data, error } = await supabase.rpc('comunidade_recuperar_leases', { p_limit: 100 })
    if (error) { console.warn('[comunidadeWorker] recuperar leases:', error.message); return 0 }
    return Number(data) || 0
  } catch (e) { console.warn('[comunidadeWorker] recuperar leases exc:', e?.message); return 0 }
}

async function claimItens() {
  try {
    const { data, error } = await supabase.rpc('comunidade_claim_fila_itens', {
      p_worker_id: cfg.workerId,
      p_limit: cfg.batchSize,
      p_lease_seconds: cfg.leaseSeconds,
      p_instancia_id: null,
    })
    if (error) { console.warn('[comunidadeWorker] claim:', error.message); return [] }
    return Array.isArray(data) ? data : []
  } catch (e) { console.warn('[comunidadeWorker] claim exc:', e?.message); return [] }
}

async function adiarItem(item, proximaIso, { voltarPendente = true } = {}) {
  await supabase.from('comunidade_fila_itens').update({
    status: voltarPendente ? 'pendente' : item.status,
    worker_id: null,
    lease_inicio: null,
    lease_ate: null,
    proxima_tentativa_em: proximaIso,
    updated_at: new Date().toISOString(),
  }).eq('id', item.id)
}

async function finalizarItem(item, patch) {
  await supabase.from('comunidade_fila_itens').update({
    ...patch,
    worker_id: null,
    lease_inicio: null,
    lease_ate: null,
    updated_at: new Date().toISOString(),
  }).eq('id', item.id)
}

function metodoDoProvider(p, tipo, operacao) {
  if (tipo === 'grupo') {
    switch (operacao) {
      case 'add': return p.addGroupParticipant
      case 'remove': return p.removeGroupParticipant
      case 'promote': return p.promoteToGroupAdmin
      case 'demote': return p.demoteGroupAdmin
      default: return null
    }
  }
  switch (operacao) {
    case 'add': return p.addCommunityParticipant
    case 'remove': return p.removeCommunityParticipant
    case 'promote': return p.promoteCommunityParticipant
    case 'demote': return p.demoteCommunityParticipant
    default: return null
  }
}

/**
 * Interpreta a resposta de add: o jid entrou (processed) ou foi recusado (failed)?
 *
 * Comparação por IDENTIDADE de WhatsApp, não por igualdade de dígitos. Medido no canal em
 * 10/11/2026: mandamos `553499911246` (o wa_id, 12 dígitos) e a Whapi respondeu
 * `{"success":true,"processed":[],"failed":["5534999911246@s.whatsapp.net"]}` — ela ecoa o
 * número com o 9º dígito. Comparando dígito a dígito, o `failed` não casava, caía no
 * `success === true` e a recusa virava "1 ok" na tela com ninguém dentro do grupo.
 *
 * E `success: true` NÃO quer dizer que alguém entrou: ele é o status da requisição. Quem manda
 * são os arrays; só na ausência dos dois é que se olha para ele.
 */
function avaliarResultadoAdd(jid, data) {
  const processed = Array.isArray(data?.processed) ? data.processed : []
  const failed = Array.isArray(data?.failed) ? data.failed : []
  const casa = (lista) => lista.some((item) => isSameWhatsappIdentity(item, jid))

  if (casa(failed)) return 'failed'
  if (casa(processed)) return 'processed'
  // Arrays presentes mas sem o nosso número: se alguém foi recusado e ninguém entrou, é recusa.
  if (failed.length > 0 && processed.length === 0) return 'failed'
  if (processed.length > 0) return 'processed'
  // Sem nada conclusivo: só então `success` decide.
  return data?.success === false ? 'failed' : 'processed'
}

async function processarItem(item) {
  const companyId = Number(item.company_id)
  const instId = Number(item.whatsapp_instance_id)
  const operacao = String(item.operacao || 'add')

  // operação ainda ativa?
  const { data: op } = await supabase
    .from('comunidade_operacoes')
    .select('id, status')
    .eq('id', item.operacao_id)
    .maybeSingle()
  if (!op || op.status !== 'em_execucao') {
    // pausada/cancelada/concluída → devolve o item para pendente (aguarda retomada)
    await adiarItem(item, new Date(Date.now() + 60000).toISOString())
    return
  }

  if (!(await tryLockInstancia(instId))) {
    await adiarItem(item, new Date(Date.now() + 3000).toISOString())
    return
  }

  try {
    // Número fora do ar: adia e espera voltar. Insistir aqui queima as tentativas do item e
    // bate no WhatsApp justamente quando a sessão está instável (ver instanciaConectada).
    if (!(await instanciaConectada(companyId, instId))) {
      console.warn(`[comunidadeWorker] instância ${instId} não está conectada — fila adiada`)
      await adiarItem(item, new Date(Date.now() + 5 * 60 * 1000).toISOString())
      return
    }

    const limites = await limitesDaInstancia(companyId, instId)
    const gate = await gateDeRitmo(companyId, instId, limites)
    if (!gate.ok) {
      await adiarItem(item, new Date(Date.now() + gate.esperaMs).toISOString())
      return
    }

    const p = provider()
    const metodo = metodoDoProvider(p, item.tipo, operacao)
    if (typeof metodo !== 'function') {
      await finalizarItem(item, { status: 'falhou', resultado: 'failed', erro_codigo: 'SEM_SUPORTE', erro_mensagem: 'Provider não suporta a operação.', concluido_em: new Date().toISOString() })
      await recalcularContadores(item.operacao_id, io, companyId)
      return
    }

    // marca enviando + tentativa ANTES da chamada (idempotência/crash-safe)
    const tentativa = Number(item.tentativas || 0) + 1
    await supabase.from('comunidade_fila_itens').update({
      status: 'enviando', tentativas: tentativa, updated_at: new Date().toISOString(),
    }).eq('id', item.id)

    const providerOpts = { companyId, whatsappInstanceId: instId }

    // Endereço real antes de agir: o número discado e o JID do WhatsApp divergem no 9º dígito.
    const endereco = await resolverEnderecoWhatsapp(p, item.participante_jid, providerOpts)
    if (endereco.jid && endereco.jid !== endereco.original) {
      console.log(`[comunidadeWorker] endereço corrigido: ${endereco.original} → ${endereco.jid}`)
    }
    if (endereco.existe === false) {
      await finalizarItem(item, {
        status: 'falhou', resultado: 'failed',
        erro_codigo: 'SEM_WHATSAPP',
        erro_mensagem: 'Este número não tem WhatsApp.',
        concluido_em: new Date().toISOString(),
      })
      if (io) emitComunidade(io, companyId, EVENTS.ITEM_ATUALIZADO, { operacao_id: item.operacao_id, item_id: item.id, status: 'falhou', jid: item.participante_jid })
      await recalcularContadores(item.operacao_id, io, companyId)
      return
    }
    // JID completo quando verificado: número cru passa por `toWhapiRecipient`, que REINSERE o
    // Endereços a tentar, SEMPRE como JID completo: número cru passa por `toWhapiRecipient`,
    // que REINSERE o 9º dígito e desfaz a resolução. Quando `checkPhones` não está disponível
    // (o canal da empresa 4 devolve 401 nesse endpoint), são as duas formas do 9º dígito —
    // mesma política de `runOnChatCandidates` nas ações de chat.
    const candidatos = (endereco.candidatos || []).length
      ? endereco.candidatos
      : [endereco.chatId || endereco.jid]

    // reserva o próximo horário permitido (espaçamento conservador) já antes da chamada
    proximoPermitidoPorInstancia.set(instId, Date.now() + intervaloComJitterMs(limites))

    let result = null
    let jidAlvo = candidatos[0]
    for (let i = 0; i < candidatos.length; i += 1) {
      jidAlvo = candidatos[i]
      result = await metodo.call(p, item.comunidade_id, [jidAlvo], providerOpts)
      // Só insiste no próximo endereço quando a chamada deu certo e o WhatsApp recusou ESTE
      // endereço: erro de transporte/rate limit segue o tratamento de sempre, logo abaixo.
      if (!result?.ok) break
      if (operacao !== 'add') break
      if (avaliarResultadoAdd(jidAlvo, result.data) !== 'failed') break
      if (i < candidatos.length - 1) {
        console.log(`[comunidadeWorker] ${jidAlvo} recusado, tentando o outro endereço do 9º dígito`)
      }
    }

    if (result?.ok) {
      let resultado = 'processed'
      // Avalia contra o endereço REALMENTE enviado — a resposta ecoa esse, não o número discado.
      if (operacao === 'add') resultado = avaliarResultadoAdd(jidAlvo, result.data)
      if (resultado === 'failed') {
        // Endereço certo e mesmo assim recusado: aí sim é privacidade/anti-spam. Terminal.
        await finalizarItem(item, {
          status: 'falhou', resultado: 'failed',
          erro_codigo: 'WHATSAPP_RECUSOU',
          erro_mensagem: 'O WhatsApp recusou adicionar este contato. Costuma ser a privacidade dele ("quem pode me adicionar a grupos") — nesse caso, use o botão de enviar o convite do grupo.',
          concluido_em: new Date().toISOString(),
        })
      } else {
        await finalizarItem(item, { status: 'concluida', resultado: 'processed', erro_codigo: null, erro_mensagem: null, concluido_em: new Date().toISOString() })
      }
      if (io) emitComunidade(io, companyId, EVENTS.ITEM_ATUALIZADO, { operacao_id: item.operacao_id, item_id: item.id, status: resultado === 'failed' ? 'falhou' : 'concluida', jid: item.participante_jid })
      await recalcularContadores(item.operacao_id, io, companyId)
      return
    }

    // ---- erro do provider ----
    const cls = classificarErro({ httpStatus: result?.httpStatus, message: result?.error })
    const httpStatus = Number(result?.httpStatus)
    const ehRateLimit = httpStatus === 429 || cls.code === 'RATE_LIMIT'

    if (ehRateLimit) {
      // sinal de limitação → PAUSA a operação inteira e adia o item
      await adiarItem(item, new Date(Date.now() + 60 * 60 * 1000).toISOString())
      await pausarOperacaoAutomatica({ io, companyId, operacaoId: item.operacao_id, motivo: 'rate_limit' })
      limitesCache.delete(instId)
      return
    }

    const atingiuMax = tentativa >= Number(item.max_tentativas || cfg.maxTentativas)
    if (cls.classificacao === 'permanente' || atingiuMax) {
      await finalizarItem(item, {
        status: 'falhou', resultado: 'failed',
        erro_codigo: cls.code || 'FALHA',
        erro_mensagem: String(result?.error || 'Falha ao processar.').slice(0, 500),
        concluido_em: new Date().toISOString(),
      })
      if (io) emitComunidade(io, companyId, EVENTS.ITEM_ATUALIZADO, { operacao_id: item.operacao_id, item_id: item.id, status: 'falhou', jid: item.participante_jid })
      await recalcularContadores(item.operacao_id, io, companyId)
      return
    }

    // temporário → backoff
    const proxima = calcularProximaTentativa({
      tentativas: tentativa, baseSec: cfg.backoffBaseSec, maxSec: cfg.backoffMaxSec,
    })
    await adiarItem(item, proxima)
  } finally {
    await unlockInstancia(instId)
  }
}

async function tick() {
  if (shuttingDown || processing || !cfg.workerEnabled) return
  processing = true
  try {
    await recuperarLeases()
    const itens = await claimItens()
    for (let i = 0; i < itens.length; i++) {
      if (shuttingDown) break
      try { await processarItem(itens[i]) } catch (e) {
        console.error(`[comunidadeWorker] item ${itens[i]?.id} erro:`, e?.message || e)
      }
    }
  } catch (e) {
    console.error('[comunidadeWorker] tick erro:', e?.message)
  } finally {
    processing = false
  }
}

function startComunidadeWorker(socketIo = null) {
  if (started) return stopComunidadeWorker
  started = true
  shuttingDown = false
  if (socketIo) io = socketIo
  console.log('[comunidadeWorker] iniciando', {
    workerId: cfg.workerId, workerEnabled: cfg.workerEnabled, pollMs: cfg.pollMs, batchSize: cfg.batchSize,
  })
  if (cfg.workerEnabled) {
    loopTimer = setInterval(() => { tick().catch(() => {}) }, cfg.pollMs)
    tick().catch(() => {})
  } else {
    console.warn('[comunidadeWorker] COMUNIDADE_WORKER_ENABLED=false — fila não será processada.')
  }
  return stopComunidadeWorker
}

async function stopComunidadeWorker() {
  shuttingDown = true
  if (loopTimer) { clearInterval(loopTimer); loopTimer = null }
  const start = Date.now()
  while (processing && Date.now() - start < 8000) {
    await new Promise((r) => setTimeout(r, 200))
  }
  started = false
  shuttingDown = false
  console.log('[comunidadeWorker] encerrado.')
}

async function main() {
  startComunidadeWorker()
  const shutdown = async (sig, code = 0) => { console.log(`[comunidadeWorker] desligando (${sig})`); await stopComunidadeWorker(); process.exit(code) }
  process.on('SIGINT', () => shutdown('SIGINT').catch(() => process.exit(0)))
  process.on('SIGTERM', () => shutdown('SIGTERM').catch(() => process.exit(0)))
}

if (require.main === module) {
  main().catch((e) => { console.error('[comunidadeWorker] fatal:', e); process.exit(1) })
}

module.exports = {
  startComunidadeWorker,
  stopComunidadeWorker,
  tick,
  processarItem,
  avaliarResultadoAdd,
  gateDeRitmo,
  _setIo: (socketIo) => { io = socketIo },
}
