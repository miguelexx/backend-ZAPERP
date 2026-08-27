/**
 * Worker do Disparo de Mensagens (Etapa 7).
 *
 * Modo padrão: loop embarcado no processo HTTP (`startEmbeddedWorker` em index.js).
 * Assim "Iniciar campanha" processa a fila sem um processo extra.
 * Processo separado continua opcional: npm run worker:disparo
 *
 * Envio real somente com WORKER_ENABLED=true + LIVE_ENABLED=true + DRY_RUN=false.
 * O loop embarcado processa a fila mesmo com WORKER_ENABLED=false (dry-run / simulação).
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })

const os = require('os')
const supabase = require('../config/supabase')
const { getDisparoWorkerConfig, getBooleanEnv } = require('../helpers/disparoWorkerConfig')
const { classificarErro, calcularProximaTentativa } = require('../helpers/disparoFilaRetryHelper')
const { enviarItemFila } = require('../services/disparoSendService')
const { recalcularContadores, registrarEvento } = require('../services/disparoFilaService')
const { podeEnviarAgora, contarEnviosJanela } = require('../services/disparoLimitesRuntime')
const { emitDisparo, EVENTS } = require('../services/disparoSocketService')
const { DateTime } = require('luxon')

const cfg = getDisparoWorkerConfig()
let shuttingDown = false
let io = null // no HTTP, index.js injeta o Socket.IO via startEmbeddedWorker
let loopTimer = null
let processing = false
let embeddedStarted = false

function embeddedWorkerAllowed() {
  if (typeof getBooleanEnv !== 'function') return true
  return getBooleanEnv('DISPARO_EMBEDDED_WORKER', true)
}

function isEmbeddedRunning() {
  return loopTimer != null
}

function logBootFlags(mode) {
  console.log(`[disparoWorker] iniciando (${mode})`, {
    workerId: cfg.workerId,
    workerEnabled: cfg.workerEnabled,
    liveEnabled: cfg.liveEnabled,
    dryRun: cfg.dryRun,
    canSendLive: cfg.canSendLive,
  })
  if (!cfg.canSendLive) {
    console.log('[disparoWorker] Modo seguro: dry-run ou live desligado — UltraMSG NÃO será chamado.')
  } else {
    console.warn('[disparoWorker] ATENÇÃO: envio REAL habilitado (WORKER+LIVE+DRY_RUN=false).')
  }
}

function startLoop() {
  if (loopTimer) return
  loopTimer = setInterval(() => { tick().catch(() => {}) }, cfg.pollMs)
  tick().catch(() => {})
}

/**
 * Loop no mesmo processo HTTP. Não exige DISPARO_WORKER_ENABLED.
 * Kill switch: DISPARO_EMBEDDED_WORKER=false.
 */
function startEmbeddedWorker(socketIo = null) {
  if (socketIo) io = socketIo
  if (!embeddedWorkerAllowed()) {
    console.log('[disparoWorker] DISPARO_EMBEDDED_WORKER=false — loop não inicia no HTTP.')
    return { started: false, skipped: true, alreadyRunning: false }
  }
  if (loopTimer || embeddedStarted) {
    return { started: false, skipped: false, alreadyRunning: true }
  }
  shuttingDown = false
  embeddedStarted = true
  logBootFlags('embarcado no HTTP')
  heartbeat({ boot: true, embedded: true }).catch(() => {})
  startLoop()
  return { started: true, skipped: false, alreadyRunning: false }
}

/** Dispara um tick imediato se o loop estiver ativo (iniciar/retomar campanha). */
function kickWorker() {
  if (shuttingDown || !loopTimer) return false
  tick().catch((e) => {
    console.warn('[disparoWorker] kick falhou:', e?.message)
  })
  return true
}

function stopEmbeddedWorker() {
  if (loopTimer) {
    clearInterval(loopTimer)
    loopTimer = null
  }
  embeddedStarted = false
}

async function heartbeat(extra = {}) {
  try {
    await supabase.from('disparo_worker_heartbeat').upsert({
      worker_id: cfg.workerId,
      hostname: os.hostname(),
      pid: process.pid,
      dry_run: cfg.dryRun,
      live_enabled: cfg.liveEnabled,
      ultima_atividade_em: new Date().toISOString(),
      meta: { ...extra, canSendLive: cfg.canSendLive },
    }, { onConflict: 'worker_id' })
  } catch (e) {
    console.warn('[disparoWorker] heartbeat falhou:', e?.message)
  }
}

async function recuperarLeases() {
  try {
    const { data, error } = await supabase.rpc('disparo_recuperar_leases_expirados', { p_limit: 100 })
    if (error) {
      console.warn('[disparoWorker] recuperar leases:', error.message)
      return 0
    }
    return Number(data) || 0
  } catch (e) {
    console.warn('[disparoWorker] recuperar leases exceção:', e?.message)
    return 0
  }
}

async function claimItens() {
  const { data, error } = await supabase.rpc('disparo_claim_fila_itens', {
    p_worker_id: cfg.workerId,
    p_limit: cfg.batchSize,
    p_lease_seconds: cfg.leaseSeconds,
    p_instancia_id: null,
  })
  if (error) {
    console.warn('[disparoWorker] claim:', error.message)
    return []
  }
  return Array.isArray(data) ? data : []
}

async function tryLockInstancia(instanciaId) {
  const { data, error } = await supabase.rpc('disparo_try_lock_instancia', { p_instancia_id: instanciaId })
  if (error) {
    console.warn('[disparoWorker] lock instancia:', error.message)
    return false
  }
  return data === true
}

async function unlockInstancia(instanciaId) {
  try {
    await supabase.rpc('disparo_unlock_instancia', { p_instancia_id: instanciaId })
  } catch (_) { /* ignore */ }
}

async function carregarLimitesContexto(item) {
  const [{ data: limites }, { data: janelas }, { data: override }, { data: execucao }] = await Promise.all([
    supabase.from('disparo_campanha_limites').select('*').eq('campanha_id', item.campanha_id).eq('company_id', item.company_id).maybeSingle(),
    supabase.from('disparo_campanha_janelas').select('*').eq('campanha_id', item.campanha_id).eq('company_id', item.company_id),
    supabase.from('disparo_campanha_instancia_limites').select('*').eq('campanha_id', item.campanha_id).eq('instancia_id', item.instancia_id).eq('company_id', item.company_id).maybeSingle(),
    supabase.from('disparo_execucoes').select('id, status, dry_run').eq('id', item.execucao_id).eq('company_id', item.company_id).maybeSingle(),
  ])
  return { limites, janelas: janelas || [], override, execucao }
}

async function adiarItem(item, proximaIso, motivo) {
  await supabase.from('disparo_fila_itens').update({
    status: 'pendente',
    worker_id: null,
    lease_inicio: null,
    lease_ate: null,
    proxima_tentativa_em: proximaIso,
    erro_mensagem: String(motivo || '').slice(0, 500) || null,
    atualizado_em: new Date().toISOString(),
  }).eq('id', item.id).eq('company_id', item.company_id)
}

/**
 * Pausa operacional da execução (não cancela itens). Isolada por company_id.
 */
async function pausarExecucaoAutomatica(item, { tipoPausa, motivo }) {
  const agora = new Date().toISOString()
  const { data: exec } = await supabase
    .from('disparo_execucoes')
    .select('id, status')
    .eq('id', item.execucao_id)
    .eq('company_id', item.company_id)
    .maybeSingle()
  if (!exec || exec.status !== 'em_execucao') return false

  await supabase.from('disparo_execucoes').update({
    status: 'pausada',
    motivo_pausa: String(motivo || '').slice(0, 500),
    tipo_pausa: tipoPausa || 'operacional',
    atualizado_em: agora,
  }).eq('id', item.execucao_id).eq('company_id', item.company_id).eq('status', 'em_execucao')

  await supabase.from('disparo_campanhas').update({
    status: 'pausada',
    atualizado_em: agora,
  }).eq('id', item.campanha_id).eq('company_id', item.company_id).eq('status', 'em_execucao')

  try {
    await supabase.from('disparo_pausas').insert({
      company_id: item.company_id,
      campanha_id: item.campanha_id,
      execucao_id: item.execucao_id,
      tipo_pausa: tipoPausa || 'operacional',
      escopo: 'campanha',
      motivo: String(motivo || '').slice(0, 500),
      iniciado_em: agora,
    })
  } catch (_) { /* best-effort */ }

  await registrarEvento({
    companyId: item.company_id,
    execucaoId: item.execucao_id,
    campanhaId: item.campanha_id,
    tipo: 'pausada',
    payload: { automatica: true, tipo_pausa: tipoPausa, motivo },
  })
  emitDisparo(io, item.company_id, EVENTS.CAMPANHA_PAUSADA, {
    campanha_id: item.campanha_id,
    execucao_id: item.execucao_id,
    motivo,
    tipo_pausa: tipoPausa,
    automatica: true,
  })
  return true
}

async function avaliarPausaPorFalhas(item, limites) {
  const maxConsec = Number(limites?.pausa_auto_erros_consecutivos) || 0
  const taxaPct = Number(limites?.pausa_auto_taxa_falha_pct) || 0
  if (maxConsec <= 0 && taxaPct <= 0) return

  if (maxConsec > 0) {
    const { data: recentes } = await supabase
      .from('disparo_fila_itens')
      .select('status')
      .eq('execucao_id', item.execucao_id)
      .eq('company_id', item.company_id)
      .in('status', ['enviada', 'entregue', 'lida', 'falhou'])
      .order('atualizado_em', { ascending: false })
      .limit(maxConsec)
    const rows = recentes || []
    if (rows.length >= maxConsec && rows.every((r) => r.status === 'falhou')) {
      await pausarExecucaoAutomatica(item, {
        tipoPausa: 'erro',
        motivo: `${maxConsec} erros consecutivos`,
      })
      return
    }
  }

  if (taxaPct > 0) {
    const { data: contagens } = await supabase
      .from('disparo_fila_itens')
      .select('status')
      .eq('execucao_id', item.execucao_id)
      .eq('company_id', item.company_id)
      .in('status', ['enviada', 'entregue', 'lida', 'falhou'])
    const rows = contagens || []
    if (rows.length >= 10) {
      const falhas = rows.filter((r) => r.status === 'falhou').length
      const pct = (falhas / rows.length) * 100
      if (pct >= taxaPct) {
        await pausarExecucaoAutomatica(item, {
          tipoPausa: 'erro',
          motivo: `Taxa de falha ${pct.toFixed(1)}% >= ${taxaPct}%`,
        })
      }
    }
  }
}

async function processarItem(item) {
  const locked = await tryLockInstancia(item.instancia_id)
  if (!locked) {
    await adiarItem(item, new Date(Date.now() + 3000).toISOString(), 'Instância ocupada por outro worker')
    return
  }

  try {
    const ctx = await carregarLimitesContexto(item)
    if (!ctx.execucao || ctx.execucao.status !== 'em_execucao') {
      await adiarItem(item, new Date(Date.now() + 10000).toISOString(), 'Execução não está em_execucao')
      return
    }

    // Instância: só bloqueia se inativa. Status "disconnected" no banco pode ser falso
    // (payload UltraMSG aninhado). Tenta live; se incerto, segue com o envio.
    const { data: inst } = await supabase.from('whatsapp_instances')
      .select('id, status, ativo, nome')
      .eq('id', item.instancia_id)
      .eq('company_id', item.company_id)
      .maybeSingle()
    if (!inst || inst.ativo === false) {
      await adiarItem(item, new Date(Date.now() + 60000).toISOString(), 'Instância inativa')
      emitDisparo(io, item.company_id, EVENTS.INSTANCIA_DESCONECTADA, {
        campanha_id: item.campanha_id,
        instancia_id: item.instancia_id,
        nome: inst?.nome,
      })
      return
    }

    const statusOk = ['connected', 'authenticated', 'standby'].includes(String(inst.status || ''))
    if (!statusOk) {
      try {
        const { getStatus } = require('../services/ultramsgIntegrationService')
        const live = await getStatus(item.company_id, { whatsappInstanceId: item.instancia_id })
        if (live?.connected === true) {
          await supabase.from('whatsapp_instances')
            .update({ status: 'connected', status_at: new Date().toISOString() })
            .eq('id', inst.id)
            .eq('company_id', item.company_id)
        }
        // conclusive offline OR inconclusive: ainda tenta enviar (atendimento já usa a instância)
      } catch (_) { /* segue para envio */ }
    }

    const agora = DateTime.utc()

    if (ctx.limites?.data_limite) {
      const limiteDt = DateTime.fromISO(ctx.limites.data_limite, { zone: ctx.limites.fuso_horario || 'America/Sao_Paulo' })
      if (limiteDt.isValid && agora > limiteDt.endOf('day')) {
        await pausarExecucaoAutomatica(item, {
          tipoPausa: 'data_limite',
          motivo: 'Data limite da campanha atingida',
        })
        await adiarItem(item, new Date(Date.now() + 3600000).toISOString(), 'Data limite atingida')
        return
      }
    }

    const desdeHora = agora.minus({ minutes: 60 }).toISO()
    const inicioDia = agora.setZone(ctx.limites?.fuso_horario || 'America/Sao_Paulo').startOf('day').toUTC().toISO()
    const [enviadosHora, enviadosDia, { data: ultimo }] = await Promise.all([
      contarEnviosJanela(supabase, { companyId: item.company_id, instanciaId: item.instancia_id, desdeIso: desdeHora }),
      contarEnviosJanela(supabase, { companyId: item.company_id, instanciaId: item.instancia_id, desdeIso: inicioDia }),
      supabase.from('disparo_fila_itens')
        .select('enviado_em')
        .eq('company_id', item.company_id)
        .eq('instancia_id', item.instancia_id)
        .in('status', ['enviada', 'entregue', 'lida'])
        .order('enviado_em', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ])

    const gate = podeEnviarAgora({
      limites: ctx.limites,
      janelas: ctx.janelas,
      instanciaId: item.instancia_id,
      override: ctx.override,
      agoraIso: agora.toISO(),
      ultimoEnvioIso: ultimo?.enviado_em || null,
      enviadosUltimaHora: enviadosHora,
      enviadosHoje: enviadosDia,
    })

    if (!gate.ok) {
      await adiarItem(item, gate.proxima_tentativa_em || new Date(Date.now() + 60000).toISOString(), gate.motivo)
      if (gate.tipo_espera === 'limite') {
        emitDisparo(io, item.company_id, EVENTS.LIMITE_ATINGIDO, {
          campanha_id: item.campanha_id,
          instancia_id: item.instancia_id,
          motivo: gate.motivo,
        })
      }
      return
    }

    // Anti-duplicidade: se já houve envio aceito, não chamar o provedor de novo
    if (item.provider_message_id || item.enviado_em) {
      await supabase.from('disparo_fila_itens').update({
        status: 'incerta',
        erro_codigo: 'JA_ENVIADO',
        erro_mensagem: 'Item já possui evidência de envio — requer reconciliação',
        erro_classificacao: 'temporario',
        lease_ate: null,
        worker_id: null,
        atualizado_em: new Date().toISOString(),
      }).eq('id', item.id).eq('company_id', item.company_id)
      return
    }

    // Marca enviando ANTES da chamada (idempotência / incerteza)
    await supabase.from('disparo_fila_itens').update({
      status: 'enviando',
      tentativas: (item.tentativas || 0) + 1,
      lease_ate: new Date(Date.now() + cfg.leaseSeconds * 1000).toISOString(),
      atualizado_em: new Date().toISOString(),
    }).eq('id', item.id).eq('company_id', item.company_id)

    await heartbeat({ last_item: item.id })

    const dryRun = cfg.dryRun || ctx.execucao.dry_run === true || !cfg.canSendLive
    const result = await enviarItemFila(item, {
      dryRun,
      liveEnabled: cfg.liveEnabled && !dryRun,
      allowlist: cfg.allowlist,
      timeoutMs: cfg.sendTimeoutMs,
      io,
    })

    if (result.ok) {
      await supabase.from('disparo_fila_itens').update({
        status: 'enviada',
        provider_message_id: result.messageId || null,
        reference_id: result.referenceId || `disp-${item.id}`,
        mensagem_id: result.mensagemId || null,
        conversa_id: result.conversaId || null,
        enviado_em: new Date().toISOString(),
        worker_id: cfg.workerId,
        lease_inicio: null,
        lease_ate: null,
        erro_codigo: null,
        erro_mensagem: null,
        erro_classificacao: null,
        atualizado_em: new Date().toISOString(),
      }).eq('id', item.id).eq('company_id', item.company_id)

      emitDisparo(io, item.company_id, EVENTS.ITEM_ATUALIZADO, {
        campanha_id: item.campanha_id,
        execucao_id: item.execucao_id,
        item_id: item.id,
        status: 'enviada',
        dry_run: !!result.dryRun,
      })
    } else {
      const classif = classificarErro({
        httpStatus: result.httpStatus,
        code: result.code || result.errorCodigo,
        message: result.error,
        beforeSend: result.beforeSend === true,
      })
      const marcarIncerto = result.incerto === true || classif.incerto === true
      const codigo = classif.code || result.code || result.errorCodigo || 'TEMPORARIO'

      // Exclusão / allowlist: não retriable; não conta como falha de envio
      if (codigo === 'EXCLUIDO' || codigo === 'ALLOWLIST') {
        const statusFinal = codigo === 'EXCLUIDO' ? 'optout' : 'ignorada'
        const patch = {
          status: statusFinal,
          falhou_em: null,
          erro_codigo: codigo,
          erro_mensagem: String(result.error || '').slice(0, 500),
          erro_classificacao: 'permanente',
          lease_ate: null,
          worker_id: null,
          atualizado_em: new Date().toISOString(),
        }
        if (codigo === 'EXCLUIDO') {
          patch.optout_em = new Date().toISOString()
        }
        await supabase.from('disparo_fila_itens').update(patch)
          .eq('id', item.id).eq('company_id', item.company_id)
      } else if (marcarIncerto) {
        await supabase.from('disparo_fila_itens').update({
          status: 'incerta',
          erro_codigo: codigo || 'INCERTA',
          erro_mensagem: String(result.error || 'Resposta perdida após chamada').slice(0, 500),
          erro_classificacao: 'temporario',
          atualizado_em: new Date().toISOString(),
          lease_ate: null,
        }).eq('id', item.id).eq('company_id', item.company_id)
      } else {
        const tentativas = (item.tentativas || 0) + 1
        if (codigo === 'CREDENCIAL_INVALIDA' || classif.code === 'CREDENCIAL_INVALIDA') {
          await supabase.from('disparo_fila_itens').update({
            status: 'falhou',
            falhou_em: new Date().toISOString(),
            erro_codigo: codigo,
            erro_mensagem: String(result.error || '').slice(0, 500),
            erro_classificacao: 'permanente',
            lease_ate: null,
            worker_id: null,
            atualizado_em: new Date().toISOString(),
          }).eq('id', item.id).eq('company_id', item.company_id)
          await pausarExecucaoAutomatica(item, {
            tipoPausa: 'erro',
            motivo: 'Erro de autenticação no provedor',
          })
        } else if (classif.classificacao === 'permanente' || tentativas >= cfg.maxTentativas) {
          await supabase.from('disparo_fila_itens').update({
            status: 'falhou',
            falhou_em: new Date().toISOString(),
            erro_codigo: codigo,
            erro_mensagem: String(result.error || '').slice(0, 500),
            erro_classificacao: classif.classificacao,
            lease_ate: null,
            worker_id: null,
            atualizado_em: new Date().toISOString(),
          }).eq('id', item.id).eq('company_id', item.company_id)
          await avaliarPausaPorFalhas(item, ctx.limites)
        } else {
          const proxima = calcularProximaTentativa({
            tentativas,
            baseSec: cfg.backoffBaseSec,
            maxSec: cfg.backoffMaxSec,
            retryAfterSec: result.retryAfterSec,
          })
          await supabase.from('disparo_fila_itens').update({
            status: 'pendente',
            proxima_tentativa_em: proxima,
            erro_codigo: codigo,
            erro_mensagem: String(result.error || '').slice(0, 500),
            erro_classificacao: 'temporario',
            lease_ate: null,
            worker_id: null,
            atualizado_em: new Date().toISOString(),
          }).eq('id', item.id).eq('company_id', item.company_id)
          if (codigo === 'RATE_LIMIT' || result.httpStatus === 429) {
            await pausarExecucaoAutomatica(item, {
              tipoPausa: 'limite',
              motivo: 'Limitação do provedor (HTTP 429 / rate limit)',
            })
          }
        }
      }
    }

    await recalcularContadores(item.execucao_id, item.company_id)
    await talvezConcluir(item.execucao_id, item.company_id, item.campanha_id)
  } finally {
    await unlockInstancia(item.instancia_id)
  }
}

async function talvezConcluir(execucaoId, companyId, campanhaId) {
  const ativos = ['pendente', 'reservada', 'enviando', 'incerta']
  const { count } = await supabase.from('disparo_fila_itens')
    .select('id', { count: 'exact', head: true })
    .eq('execucao_id', execucaoId)
    .eq('company_id', companyId)
    .in('status', ativos)
  if ((count || 0) > 0) return

  const agora = new Date().toISOString()
  await supabase.from('disparo_execucoes').update({
    status: 'concluida',
    finalizado_em: agora,
    atualizado_em: agora,
  }).eq('id', execucaoId).eq('company_id', companyId).eq('status', 'em_execucao')

  await supabase.from('disparo_campanhas').update({
    status: 'concluida',
    atualizado_em: agora,
  }).eq('id', campanhaId).eq('company_id', companyId).eq('status', 'em_execucao')

  await registrarEvento({
    companyId,
    execucaoId,
    campanhaId,
    tipo: 'concluida',
    payload: {},
  })
  emitDisparo(io, companyId, EVENTS.CAMPANHA_CONCLUIDA, { campanha_id: campanhaId, execucao_id: execucaoId })
}

async function tick() {
  if (shuttingDown || processing) return
  processing = true
  try {
    await recuperarLeases()
    const itens = await claimItens()
    // Processa sequencialmente por instância no mesmo batch (uma msg por vez na prática via lock)
    for (const item of itens) {
      if (shuttingDown) break
      await processarItem(item)
    }
    await heartbeat({ claimed: itens.length })
  } catch (e) {
    console.error('[disparoWorker] tick erro:', e?.message)
  } finally {
    processing = false
  }
}

async function main() {
  logBootFlags('processo separado')

  if (!cfg.workerEnabled) {
    console.log('[disparoWorker] DISPARO_WORKER_ENABLED=false — worker separado não inicia.')
    process.exit(0)
  }

  await heartbeat({ boot: true, embedded: false })

  const shutdown = async (signal) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[disparoWorker] desligamento gracioso (${signal})…`)
    stopEmbeddedWorker()
    const start = Date.now()
    while (processing && Date.now() - start < 30000) {
      await new Promise((r) => setTimeout(r, 200))
    }
    await heartbeat({ shutdown: true })
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  startLoop()
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[disparoWorker] fatal:', e)
    process.exit(1)
  })
}

module.exports = {
  tick,
  processarItem,
  recuperarLeases,
  claimItens,
  startEmbeddedWorker,
  stopEmbeddedWorker,
  kickWorker,
  isEmbeddedRunning,
  _setIo: (socketIo) => { io = socketIo },
}
