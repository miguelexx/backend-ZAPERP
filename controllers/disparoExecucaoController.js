/**
 * Controller de Execução — módulo Disparo de Mensagens (Etapa 7).
 * Início, pausa, cancelamento, fila, eventos e saúde.
 * Nunca envia mensagens / nunca chama UltraMSG.
 */

const supabase = require('../config/supabase')
const { getDisparoFlags } = require('../helpers/disparoWorkerConfig')
const { avaliarSaudeWorker } = require('../helpers/disparoWorkerHealth')
const { mascararTelefone } = require('../helpers/disparoRevisaoChecklist')
const {
  gerarFilaParaCampanha,
  registrarEvento,
  recalcularContadores,
  DisparoFilaError,
} = require('../services/disparoFilaService')
const { emitDisparo, EVENTS } = require('../services/disparoSocketService')
const { revalidarInstanciasConectadas } = require('./disparoLimitesController')
const { registrarEvento: registrarAuditoria } = require('../services/operationalAuditService')

const EXECUCAO_SELECT = [
  'id', 'company_id', 'campanha_id', 'revisao_id', 'versao', 'config_hash',
  'status', 'motivo_pausa', 'tipo_pausa',
  'iniciado_em', 'finalizado_em', 'iniciado_por', 'pausado_por', 'cancelado_por',
  'total_itens', 'total_enviados', 'total_entregues', 'total_lidos',
  'total_falhas', 'total_incertos', 'total_ignorados', 'total_cancelados',
  'dry_run', 'criado_em', 'atualizado_em',
].join(', ')

const FILA_SAFE_SELECT = [
  'id', 'campanha_id', 'execucao_id', 'destinatario_id', 'instancia_id', 'variacao_id',
  'status', 'tentativas', 'max_tentativas',
  'planejado_para', 'proxima_tentativa_em',
  'erro_codigo', 'erro_mensagem', 'erro_classificacao',
  'enviado_em', 'entregue_em', 'lido_em', 'falhou_em', 'cancelado_em',
  'criado_em', 'atualizado_em',
].join(', ')

const EVENTO_SELECT = [
  'id', 'execucao_id', 'campanha_id', 'tipo', 'payload', 'usuario_id', 'criado_em',
].join(', ')

const DEFAULT_PAGE_LIMIT = 50
const MAX_PAGE_LIMIT = 200
const EXECUCAO_ATIVA = ['aguardando', 'em_execucao', 'pausada']
const ITENS_CANCELAVEIS = ['pendente', 'reservada']

function positiveInt(v) {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

function requireAdmin(req, res) {
  if (String(req.user?.perfil ?? '').toLowerCase() !== 'admin') {
    res.status(403).json({ error: 'Acesso restrito a administradores.' })
    return false
  }
  return true
}

function getIo(req) {
  try {
    return req.app?.get?.('io') ?? null
  } catch (_) {
    return null
  }
}

async function alinharFilaComAckDoChat(execucao, companyId, req) {
  if (!execucao?.id) return execucao
  try {
    const { sincronizarFilaComAckDoChat } = require('../services/disparoWebhookHook')
    await sincronizarFilaComAckDoChat({
      execucaoId: execucao.id,
      companyId,
      io: getIo(req),
      limit: 50,
    })
    const atualizada = await buscarExecucaoMaisRecente(execucao.campanha_id, companyId)
    return atualizada || execucao
  } catch (e) {
    console.warn('[disparo:execucao] sync ack chat:', e?.message || e)
    return execucao
  }
}

async function carregarCampanha(campanhaId, companyId, res) {
  const { data, error } = await supabase
    .from('disparo_campanhas')
    .select('id, company_id, nome, status, versao_atual, config_hash')
    .eq('id', campanhaId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw error
  if (!data) {
    res.status(404).json({ error: 'Campanha não encontrada.' })
    return null
  }
  return data
}

async function carregarLimitesAgendamento(campanhaId, companyId) {
  const { data, error } = await supabase
    .from('disparo_campanha_limites')
    .select('inicio_modo, agendado_para')
    .eq('campanha_id', campanhaId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw error
  return data
}

async function buscarExecucaoMaisRecente(campanhaId, companyId) {
  const { data, error } = await supabase
    .from('disparo_execucoes')
    .select(EXECUCAO_SELECT)
    .eq('campanha_id', campanhaId)
    .eq('company_id', companyId)
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data
}

async function buscarExecucaoAtiva(campanhaId, companyId) {
  const { data, error } = await supabase
    .from('disparo_execucoes')
    .select(EXECUCAO_SELECT)
    .eq('campanha_id', campanhaId)
    .eq('company_id', companyId)
    .in('status', EXECUCAO_ATIVA)
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data
}

function assertCampanhaIniciavel(campanha) {
  const status = String(campanha?.status || '')
  if (status === 'em_execucao' || status === 'pausada') return { ok: true, idempotente: true }
  if (status !== 'pronta' && status !== 'agendada') {
    return {
      ok: false,
      status: 422,
      error: `Campanha deve estar com status "pronta" ou "agendada" (atual: ${status || 'desconhecido'}).`,
    }
  }
  return { ok: true, idempotente: false }
}

async function recusarSeWorkerNaoSaudavel(res, { requireLive = false } = {}) {
  const saude = await avaliarSaudeWorker()
  const compativel = requireLive ? saude.saudavel_live === true : saude.saudavel
  if (compativel) return saude
  res.status(422).json({
    error: requireLive
      ? 'Nenhum worker com envio live habilitado está ativo.'
      : (saude.motivo || 'Nenhum worker ativo detectado'),
    code: requireLive ? 'WORKER_LIVE_OFFLINE' : 'WORKER_OFFLINE',
    worker_status: saude.status,
    saudavel: false,
  })
  return null
}

async function validarAgendamento(campanha, limites) {
  if (campanha.status !== 'agendada' && limites?.inicio_modo !== 'agendado') {
    return { ok: true }
  }
  const agendadoPara = limites?.agendado_para
  if (!agendadoPara) {
    return { ok: false, error: 'Campanha agendada sem data/hora configurada.' }
  }
  const limiteMs = Date.now() + 60 * 1000
  if (Date.parse(agendadoPara) > limiteMs) {
    return {
      ok: false,
      error: 'Agendamento ainda não atingido. Aguarde até 1 minuto antes do horário programado.',
      agendado_para: agendadoPara,
    }
  }
  return { ok: true }
}

async function cancelarItensPendentes(execucaoId, companyId, agora) {
  const { data: itens, error } = await supabase
    .from('disparo_fila_itens')
    .select('id, status')
    .eq('execucao_id', execucaoId)
    .eq('company_id', companyId)
    .in('status', ITENS_CANCELAVEIS)
  if (error) throw error

  const ids = (itens ?? []).map((i) => i.id)
  if (!ids.length) return 0

  const { error: updErr } = await supabase
    .from('disparo_fila_itens')
    .update({
      status: 'cancelada',
      cancelado_em: agora,
      worker_id: null,
      lease_inicio: null,
      lease_ate: null,
      atualizado_em: agora,
    })
    .eq('execucao_id', execucaoId)
    .eq('company_id', companyId)
    .in('status', ITENS_CANCELAVEIS)
  if (updErr) throw updErr

  return ids.length
}

async function montarContadoresPorStatus(execucaoId, companyId) {
  // PostgREST limita o retorno a `max-rows` (1000). Sem paginar, campanhas com
  // mais de 1000 itens teriam por_status/por_instancia subestimados. Paginamos.
  const PAGE = 1000
  const rows = []
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase
      .from('disparo_fila_itens')
      .select('status, instancia_id')
      .eq('execucao_id', execucaoId)
      .eq('company_id', companyId)
      .order('id', { ascending: true })
      .range(offset, offset + PAGE - 1)
    if (error) throw error
    if (!data?.length) break
    rows.push(...data)
    if (data.length < PAGE) break
  }

  const porStatus = {}
  const porInstancia = {}

  for (const row of rows) {
    porStatus[row.status] = (porStatus[row.status] ?? 0) + 1
    if (row.instancia_id) {
      const key = String(row.instancia_id)
      if (!porInstancia[key]) {
        porInstancia[key] = { instancia_id: row.instancia_id, total: 0, por_status: {} }
      }
      porInstancia[key].total += 1
      porInstancia[key].por_status[row.status] = (porInstancia[key].por_status[row.status] ?? 0) + 1
    }
  }

  return { por_status: porStatus, por_instancia: Object.values(porInstancia) }
}

async function enriquecerFilaItens(itens, companyId) {
  const destIds = [...new Set((itens ?? []).map((i) => i.destinatario_id).filter(Boolean))]
  if (!destIds.length) return itens ?? []

  const { data: dests } = await supabase
    .from('disparo_campanha_destinatarios')
    .select('id, nome, telefone_normalizado')
    .in('id', destIds)
    .eq('company_id', companyId)

  const destMap = (dests ?? []).reduce((m, d) => {
    m[d.id] = d
    return m
  }, {})

  return (itens ?? []).map((item) => {
    const dest = destMap[item.destinatario_id]
    return {
      ...item,
      destinatario_nome: dest?.nome ?? null,
      telefone_mascarado: dest?.telefone_normalizado
        ? mascararTelefone(dest.telefone_normalizado)
        : null,
    }
  })
}

// ─── 1. Iniciar campanha ─────────────────────────────────────────────────────

exports.iniciarCampanha = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const userId = positiveInt(req.user?.id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID de campanha inválido.' })

    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return

    const iniciavel = assertCampanhaIniciavel(campanha)
    if (!iniciavel.ok) {
      return res.status(iniciavel.status).json({ error: iniciavel.error, status: campanha.status })
    }

    if (!iniciavel.idempotente) {
      const limites = await carregarLimitesAgendamento(campanhaId, companyId)
      const agendCheck = await validarAgendamento(campanha, limites)
      if (!agendCheck.ok) {
        return res.status(422).json({
          error: agendCheck.error,
          agendado_para: agendCheck.agendado_para ?? null,
        })
      }

      const workerSaude = await recusarSeWorkerNaoSaudavel(res, {
        requireLive: getDisparoFlags().dryRun === false,
      })
      if (!workerSaude) return
    }

    let filaResult
    try {
      filaResult = await gerarFilaParaCampanha({
        companyId,
        campanhaId,
        userId,
      })
    } catch (err) {
      if (err instanceof DisparoFilaError) {
        return res.status(422).json({ error: err.message, code: err.code })
      }
      throw err
    }

    const agora = new Date().toISOString()
    let execucao = filaResult.execucao
    if (!execucao?.id) {
      return res.status(422).json({ error: 'Não foi possível criar a execução da campanha.' })
    }

    if (iniciavel.idempotente) {
      return res.json({
        ok: true,
        idempotente: true,
        campanha_status: campanha.status,
        execucao,
        fila: {
          gerados: filaResult.gerados,
          ignorados: filaResult.ignorados,
          ja_existentes: filaResult.ja_existentes,
        },
        flags: getDisparoFlags(),
      })
    }

    if (execucao.status === 'em_execucao' && campanha.status === 'em_execucao') {
      return res.json({
        ok: true,
        idempotente: true,
        campanha_status: 'em_execucao',
        execucao,
        fila: {
          gerados: filaResult.gerados,
          ignorados: filaResult.ignorados,
          ja_existentes: filaResult.ja_existentes,
        },
        flags: getDisparoFlags(),
      })
    }

    const { data: execAtualizada, error: execErr } = await supabase
      .from('disparo_execucoes')
      .update({
        status: 'em_execucao',
        iniciado_em: agora,
        iniciado_por: userId,
        atualizado_em: agora,
      })
      .eq('id', execucao.id)
      .eq('company_id', companyId)
      .select(EXECUCAO_SELECT)
      .maybeSingle()
    if (execErr) throw execErr
    if (execAtualizada) execucao = execAtualizada
    else {
      execucao = { ...execucao, status: 'em_execucao', iniciado_em: agora, iniciado_por: userId }
    }

    const { error: campErr } = await supabase
      .from('disparo_campanhas')
      .update({ status: 'em_execucao', atualizado_em: agora })
      .eq('id', campanhaId)
      .eq('company_id', companyId)
    if (campErr) throw campErr

    try {
      await registrarEvento({
        companyId,
        execucaoId: execucao.id,
        campanhaId,
        tipo: 'iniciada',
        payload: {
          versao: execucao.versao,
          dry_run: execucao.dry_run,
          fila_gerada: !filaResult.idempotente,
          gerados: filaResult.gerados,
          ignorados: filaResult.ignorados,
        },
        usuarioId: userId,
      })
    } catch (evErr) {
      console.warn('[disparo:execucao] evento iniciada:', evErr?.message || evErr)
    }

    const io = getIo(req)
    emitDisparo(io, companyId, EVENTS.CAMPANHA_INICIADA, {
      campanha_id: campanhaId,
      execucao_id: execucao.id,
      dry_run: execucao.dry_run,
    })

    res.json({
      ok: true,
      idempotente: false,
      campanha_status: 'em_execucao',
      execucao,
      fila: {
        gerados: filaResult.gerados,
        ignorados: filaResult.ignorados,
        ja_existentes: filaResult.ja_existentes,
      },
      flags: getDisparoFlags(),
    })
  } catch (err) {
    console.error('[disparo:execucao] iniciarCampanha', err)
    if (err instanceof DisparoFilaError) {
      return res.status(422).json({ error: err.message, code: err.code })
    }
    const detail = String(err?.message || err?.details || '').slice(0, 300)
    res.status(500).json({
      error: detail || 'Erro ao iniciar execução da campanha.',
      code: err?.code || 'INICIAR_FALHOU',
    })
  }
}

// ─── 2. Obter execução ───────────────────────────────────────────────────────

exports.obterExecucao = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID de campanha inválido.' })

    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return

    let execucao = await buscarExecucaoMaisRecente(campanhaId, companyId)
    execucao = await alinharFilaComAckDoChat(execucao, companyId, req)

    res.json({
      campanha: {
        id: campanha.id,
        nome: campanha.nome,
        status: campanha.status,
      },
      execucao: execucao ?? null,
      contadores: execucao
        ? {
            total_itens: execucao.total_itens,
            total_enviados: execucao.total_enviados,
            total_entregues: execucao.total_entregues,
            total_lidos: execucao.total_lidos,
            total_falhas: execucao.total_falhas,
            total_incertos: execucao.total_incertos,
            total_ignorados: execucao.total_ignorados,
            total_cancelados: execucao.total_cancelados,
          }
        : null,
      flags: getDisparoFlags(),
    })
  } catch (err) {
    console.error('[disparo:execucao] obterExecucao', err)
    res.status(500).json({ error: 'Erro ao consultar execução.' })
  }
}

// ─── 3. Listar fila ──────────────────────────────────────────────────────────

exports.listarFila = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID de campanha inválido.' })

    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return

    const execucao = await buscarExecucaoMaisRecente(campanhaId, companyId)
    if (!execucao) {
      return res.json({ page: 1, limit: DEFAULT_PAGE_LIMIT, total: 0, total_pages: 0, itens: [] })
    }

    const page = Math.max(1, positiveInt(req.query.page) ?? 1)
    const limit = Math.min(MAX_PAGE_LIMIT, positiveInt(req.query.limit) ?? DEFAULT_PAGE_LIMIT)
    const offset = (page - 1) * limit
    const statusFiltro = String(req.query.status ?? '').trim()

    let query = supabase
      .from('disparo_fila_itens')
      .select(FILA_SAFE_SELECT, { count: 'exact' })
      .eq('execucao_id', execucao.id)
      .eq('company_id', companyId)
      .order('id', { ascending: true })
      .range(offset, offset + limit - 1)

    if (statusFiltro) query = query.eq('status', statusFiltro)

    const { data, error, count } = await query
    if (error) throw error

    const itens = await enriquecerFilaItens(data, companyId)

    res.json({
      execucao_id: execucao.id,
      page,
      limit,
      total: count ?? 0,
      total_pages: Math.ceil((count ?? 0) / limit) || 0,
      itens,
    })
  } catch (err) {
    console.error('[disparo:execucao] listarFila', err)
    res.status(500).json({ error: 'Erro ao listar fila de execução.' })
  }
}

// ─── 4. Resumo execução ──────────────────────────────────────────────────────

exports.resumoExecucao = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID de campanha inválido.' })

    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return

    let execucao = await buscarExecucaoMaisRecente(campanhaId, companyId)
    if (!execucao) {
      return res.json({
        campanha_id: campanhaId,
        execucao: null,
        por_status: {},
        por_instancia: [],
      })
    }

    execucao = await alinharFilaComAckDoChat(execucao, companyId, req)

    const detalhes = await montarContadoresPorStatus(execucao.id, companyId)
    const instanciaIds = detalhes.por_instancia.map((i) => i.instancia_id).filter(Boolean)
    let nomes = {}
    if (instanciaIds.length) {
      const { data: inst } = await supabase
        .from('whatsapp_instances')
        .select('id, nome, status, ativo')
        .in('id', instanciaIds)
        .eq('company_id', companyId)
      nomes = (inst ?? []).reduce((m, i) => {
        m[i.id] = i
        return m
      }, {})
    }

    res.json({
      campanha_id: campanhaId,
      campanha_status: campanha.status,
      execucao: {
        id: execucao.id,
        status: execucao.status,
        dry_run: execucao.dry_run,
        iniciado_em: execucao.iniciado_em,
        finalizado_em: execucao.finalizado_em,
      },
      contadores: {
        total_itens: execucao.total_itens,
        total_enviados: execucao.total_enviados,
        total_entregues: execucao.total_entregues,
        total_lidos: execucao.total_lidos,
        total_falhas: execucao.total_falhas,
        total_incertos: execucao.total_incertos,
        total_ignorados: execucao.total_ignorados,
        total_cancelados: execucao.total_cancelados,
      },
      por_status: detalhes.por_status,
      por_instancia: detalhes.por_instancia.map((linha) => ({
        ...linha,
        instancia_nome: nomes[linha.instancia_id]?.nome ?? `#${linha.instancia_id}`,
        instancia_status: nomes[linha.instancia_id]?.status ?? null,
        instancia_ativa: nomes[linha.instancia_id]?.ativo ?? null,
      })),
    })
  } catch (err) {
    console.error('[disparo:execucao] resumoExecucao', err)
    res.status(500).json({ error: 'Erro ao gerar resumo da execução.' })
  }
}

// ─── 5. Pausar ───────────────────────────────────────────────────────────────

exports.pausar = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const userId = req.user?.id ?? null
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID de campanha inválido.' })

    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return

    if (campanha.status !== 'em_execucao') {
      return res.status(422).json({
        error: 'Somente campanhas em execução podem ser pausadas.',
        status: campanha.status,
      })
    }

    const execucao = await buscarExecucaoAtiva(campanhaId, companyId)
    if (!execucao || execucao.status !== 'em_execucao') {
      return res.status(422).json({ error: 'Nenhuma execução ativa encontrada para pausar.' })
    }

    const agora = new Date().toISOString()
    const motivo = String(req.body?.motivo ?? '').trim().slice(0, 500) || 'Pausa manual solicitada pelo administrador.'

    const { data: execAtualizada, error: execErr } = await supabase
      .from('disparo_execucoes')
      .update({
        status: 'pausada',
        motivo_pausa: motivo,
        tipo_pausa: 'manual',
        pausado_por: userId,
        atualizado_em: agora,
      })
      .eq('id', execucao.id)
      .eq('company_id', companyId)
      .eq('status', 'em_execucao')
      .select(EXECUCAO_SELECT)
      .maybeSingle()
    if (execErr) throw execErr
    if (!execAtualizada) {
      return res.status(409).json({ error: 'Execução já foi alterada por outro processo.' })
    }

    await supabase.from('disparo_campanhas')
      .update({ status: 'pausada', atualizado_em: agora })
      .eq('id', campanhaId)
      .eq('company_id', companyId)

    await supabase.from('disparo_pausas').insert({
      company_id: companyId,
      execucao_id: execucao.id,
      campanha_id: campanhaId,
      tipo_pausa: 'manual',
      motivo,
      escopo: 'campanha',
      iniciado_por: userId,
    })

    await registrarEvento({
      companyId,
      execucaoId: execucao.id,
      campanhaId,
      tipo: 'pausada',
      payload: { motivo, tipo_pausa: 'manual' },
      usuarioId: userId,
    })

    const io = getIo(req)
    emitDisparo(io, companyId, EVENTS.CAMPANHA_PAUSADA, {
      campanha_id: campanhaId,
      execucao_id: execucao.id,
      motivo,
    })

    res.json({ ok: true, status: 'pausada', execucao: execAtualizada })
  } catch (err) {
    console.error('[disparo:execucao] pausar', err)
    res.status(500).json({ error: 'Erro ao pausar execução.' })
  }
}

// ─── 6. Continuar ────────────────────────────────────────────────────────────

exports.continuar = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const userId = req.user?.id ?? null
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID de campanha inválido.' })

    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return

    if (campanha.status !== 'pausada') {
      return res.status(422).json({
        error: 'Somente campanhas pausadas podem ser retomadas.',
        status: campanha.status,
      })
    }

    const instCheck = await revalidarInstanciasConectadas(campanhaId, companyId)
    if (!instCheck.ok) {
      return res.status(422).json({
        error: instCheck.mensagem || 'Instâncias desconectadas ou inativas.',
        desconectadas: instCheck.desconectadas,
      })
    }

    const execucao = await buscarExecucaoAtiva(campanhaId, companyId)
    if (!execucao || execucao.status !== 'pausada') {
      return res.status(422).json({ error: 'Nenhuma execução pausada encontrada.' })
    }

    try {
      await gerarFilaParaCampanha({
        companyId,
        campanhaId,
        userId,
      })
    } catch (err) {
      if (err instanceof DisparoFilaError) {
        return res.status(422).json({ error: err.message, code: err.code })
      }
      throw err
    }

    const workerSaude = await recusarSeWorkerNaoSaudavel(res, {
      requireLive: execucao.dry_run === false,
    })
    if (!workerSaude) return

    const agora = new Date().toISOString()

    const { data: execAtualizada, error: execErr } = await supabase
      .from('disparo_execucoes')
      .update({
        status: 'em_execucao',
        motivo_pausa: null,
        tipo_pausa: null,
        atualizado_em: agora,
      })
      .eq('id', execucao.id)
      .eq('company_id', companyId)
      .eq('status', 'pausada')
      .select(EXECUCAO_SELECT)
      .maybeSingle()
    if (execErr) throw execErr
    if (!execAtualizada) {
      return res.status(409).json({ error: 'Execução já foi alterada por outro processo.' })
    }

    await supabase.from('disparo_campanhas')
      .update({ status: 'em_execucao', atualizado_em: agora })
      .eq('id', campanhaId)
      .eq('company_id', companyId)

    await supabase.from('disparo_pausas')
      .update({ finalizado_em: agora })
      .eq('execucao_id', execucao.id)
      .eq('company_id', companyId)
      .is('finalizado_em', null)

    await registrarEvento({
      companyId,
      execucaoId: execucao.id,
      campanhaId,
      tipo: 'retomada',
      payload: {},
      usuarioId: userId,
    })

    const io = getIo(req)
    emitDisparo(io, companyId, EVENTS.CAMPANHA_RETOMADA, {
      campanha_id: campanhaId,
      execucao_id: execucao.id,
    })

    res.json({ ok: true, status: 'em_execucao', execucao: execAtualizada, instancias: instCheck })
  } catch (err) {
    console.error('[disparo:execucao] continuar', err)
    res.status(500).json({ error: 'Erro ao retomar execução.' })
  }
}

// ─── 7. Cancelar ─────────────────────────────────────────────────────────────

exports.cancelar = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const userId = req.user?.id ?? null
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID de campanha inválido.' })

    if (req.body?.confirmacao !== true) {
      return res.status(422).json({ error: 'Confirmação explícita é necessária (confirmacao: true).' })
    }

    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return

    if (!['em_execucao', 'pausada', 'agendada', 'pronta'].includes(campanha.status)) {
      return res.status(422).json({
        error: 'Campanha não pode ser cancelada nesta fase.',
        status: campanha.status,
      })
    }

    const execucao = await buscarExecucaoAtiva(campanhaId, companyId)
      || await buscarExecucaoMaisRecente(campanhaId, companyId)

    const agora = new Date().toISOString()
    let cancelados = 0

    if (execucao && EXECUCAO_ATIVA.includes(execucao.status)) {
      cancelados = await cancelarItensPendentes(execucao.id, companyId, agora)
      await recalcularContadores(execucao.id, companyId)

      await supabase.from('disparo_execucoes')
        .update({
          status: 'cancelada',
          cancelado_por: userId,
          finalizado_em: agora,
          atualizado_em: agora,
        })
        .eq('id', execucao.id)
        .eq('company_id', companyId)

      await registrarEvento({
        companyId,
        execucaoId: execucao.id,
        campanhaId,
        tipo: 'cancelada',
        payload: { itens_cancelados: cancelados },
        usuarioId: userId,
      })
    }

    await supabase.from('disparo_campanhas')
      .update({ status: 'cancelada', atualizado_em: agora })
      .eq('id', campanhaId)
      .eq('company_id', companyId)

    const io = getIo(req)
    emitDisparo(io, companyId, EVENTS.CAMPANHA_CANCELADA, {
      campanha_id: campanhaId,
      execucao_id: execucao?.id ?? null,
      itens_cancelados: cancelados,
    })

    res.json({
      ok: true,
      status: 'cancelada',
      itens_cancelados: cancelados,
      execucao_id: execucao?.id ?? null,
    })
  } catch (err) {
    console.error('[disparo:execucao] cancelar', err)
    res.status(500).json({ error: 'Erro ao cancelar execução.' })
  }
}

// ─── 8. Emergência (empresa) ─────────────────────────────────────────────────

exports.emergencia = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const userId = req.user?.id ?? null

    if (req.body?.confirmacao !== 'EMERGENCIA') {
      return res.status(422).json({
        error: 'Confirmação de emergência inválida. Informe confirmacao: "EMERGENCIA".',
      })
    }

    const agora = new Date().toISOString()

    const { data: execucoes, error: listErr } = await supabase
      .from('disparo_execucoes')
      .select('id, campanha_id, status')
      .eq('company_id', companyId)
      .in('status', EXECUCAO_ATIVA)
    if (listErr) throw listErr

    let totalItensCancelados = 0
    const campanhaIds = new Set()

    for (const exec of execucoes ?? []) {
      campanhaIds.add(exec.campanha_id)
      const qtd = await cancelarItensPendentes(exec.id, companyId, agora)
      totalItensCancelados += qtd
      await recalcularContadores(exec.id, companyId)

      await supabase.from('disparo_execucoes')
        .update({
          status: 'emergencia',
          tipo_pausa: 'emergencia',
          motivo_pausa: 'Parada de emergência acionada pelo administrador.',
          cancelado_por: userId,
          finalizado_em: agora,
          atualizado_em: agora,
        })
        .eq('id', exec.id)
        .eq('company_id', companyId)

      await supabase.from('disparo_pausas').insert({
        company_id: companyId,
        execucao_id: exec.id,
        campanha_id: exec.campanha_id,
        tipo_pausa: 'emergencia',
        motivo: 'Parada de emergência — todos os envios da empresa interrompidos.',
        escopo: 'campanha',
        iniciado_por: userId,
        finalizado_em: agora,
      })

      await registrarEvento({
        companyId,
        execucaoId: exec.id,
        campanhaId: exec.campanha_id,
        tipo: 'emergencia',
        payload: { itens_cancelados: qtd },
        usuarioId: userId,
      })
    }

    if (campanhaIds.size) {
      await supabase.from('disparo_campanhas')
        .update({ status: 'cancelada', atualizado_em: agora })
        .eq('company_id', companyId)
        .in('id', [...campanhaIds])
        .in('status', ['em_execucao', 'pausada', 'agendada', 'pronta'])
    }

    await registrarAuditoria(companyId, 'pausa', 'disparo_emergencia', {
      usuario_id: userId,
      execucoes_afetadas: (execucoes ?? []).length,
      campanhas_afetadas: campanhaIds.size,
      itens_cancelados: totalItensCancelados,
    })

    const io = getIo(req)
    for (const exec of execucoes ?? []) {
      emitDisparo(io, companyId, EVENTS.CAMPANHA_CANCELADA, {
        campanha_id: exec.campanha_id,
        execucao_id: exec.id,
        emergencia: true,
      })
    }

    res.json({
      ok: true,
      execucoes_afetadas: (execucoes ?? []).length,
      campanhas_afetadas: campanhaIds.size,
      itens_cancelados: totalItensCancelados,
    })
  } catch (err) {
    console.error('[disparo:execucao] emergencia', err)
    res.status(500).json({ error: 'Erro ao acionar parada de emergência.' })
  }
}

// ─── 9. Reprocessar falhas ───────────────────────────────────────────────────

exports.reprocessarFalhas = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const userId = req.user?.id ?? null
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID de campanha inválido.' })

    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return

    if (!['em_execucao', 'pausada'].includes(campanha.status)) {
      return res.status(422).json({
        error: 'Reprocessamento disponível apenas com campanha em execução ou pausada.',
        status: campanha.status,
      })
    }

    const execucao = await buscarExecucaoAtiva(campanhaId, companyId)
    if (!execucao) {
      return res.status(422).json({ error: 'Nenhuma execução ativa encontrada.' })
    }

    const agora = new Date().toISOString()
    const itemIds = Array.isArray(req.body?.item_ids)
      ? req.body.item_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0)
      : null

    let query = supabase
      .from('disparo_fila_itens')
      .select('id, erro_classificacao')
      .eq('execucao_id', execucao.id)
      .eq('company_id', companyId)
      .eq('status', 'falhou')

    if (itemIds?.length) {
      query = query.in('id', itemIds)
    } else {
      query = query.eq('erro_classificacao', 'temporario')
    }

    const { data: candidatos, error: selErr } = await query
    if (selErr) throw selErr

    const ids = (candidatos ?? []).map((i) => i.id)
    if (!ids.length) {
      return res.json({ ok: true, reprocessados: 0, mensagem: 'Nenhum item elegível para reprocessamento.' })
    }

    const { error: updErr } = await supabase
      .from('disparo_fila_itens')
      .update({
        status: 'pendente',
        proxima_tentativa_em: agora,
        erro_codigo: null,
        erro_mensagem: null,
        erro_classificacao: null,
        falhou_em: null,
        worker_id: null,
        lease_inicio: null,
        lease_ate: null,
        atualizado_em: agora,
      })
      .eq('execucao_id', execucao.id)
      .eq('company_id', companyId)
      .in('id', ids)
      .eq('status', 'falhou')
    if (updErr) throw updErr

    await recalcularContadores(execucao.id, companyId)

    await registrarEvento({
      companyId,
      execucaoId: execucao.id,
      campanhaId,
      tipo: 'reprocessamento',
      payload: { item_ids: ids, quantidade: ids.length },
      usuarioId: userId,
    })

    res.json({ ok: true, reprocessados: ids.length, item_ids: ids })
  } catch (err) {
    console.error('[disparo:execucao] reprocessarFalhas', err)
    res.status(500).json({ error: 'Erro ao reprocessar falhas.' })
  }
}

// ─── 10. Listar eventos ──────────────────────────────────────────────────────

exports.listarEventos = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID de campanha inválido.' })

    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return

    const execucao = await buscarExecucaoMaisRecente(campanhaId, companyId)
    if (!execucao) {
      return res.json({ execucao_id: null, eventos: [] })
    }

    const page = Math.max(1, positiveInt(req.query.page) ?? 1)
    const limit = Math.min(MAX_PAGE_LIMIT, positiveInt(req.query.limit) ?? DEFAULT_PAGE_LIMIT)
    const offset = (page - 1) * limit

    const { data, error, count } = await supabase
      .from('disparo_execucao_eventos')
      .select(EVENTO_SELECT, { count: 'exact' })
      .eq('execucao_id', execucao.id)
      .eq('company_id', companyId)
      .order('criado_em', { ascending: false })
      .range(offset, offset + limit - 1)
    if (error) throw error

    res.json({
      execucao_id: execucao.id,
      page,
      limit,
      total: count ?? 0,
      total_pages: Math.ceil((count ?? 0) / limit) || 0,
      eventos: data ?? [],
    })
  } catch (err) {
    console.error('[disparo:execucao] listarEventos', err)
    res.status(500).json({ error: 'Erro ao listar eventos da execução.' })
  }
}

// ─── 11. Saúde instâncias ────────────────────────────────────────────────────

exports.saudeInstancias = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID de campanha inválido.' })

    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return

    const { data: configs, error: cfgErr } = await supabase
      .from('disparo_campanha_instancias')
      .select('instancia_id, ordem, ativa')
      .eq('campanha_id', campanhaId)
      .eq('company_id', companyId)
      .order('ordem', { ascending: true })
    if (cfgErr) throw cfgErr

    const ids = (configs ?? []).map((c) => c.instancia_id).filter(Boolean)
    if (!ids.length) {
      return res.json({ campanha_id: campanhaId, instancias: [] })
    }

    const [{ data: wa, error: waErr }, execucao] = await Promise.all([
      supabase
        .from('whatsapp_instances')
        .select('id, nome, status, ativo, display_phone, telefone_conectado')
        .in('id', ids)
        .eq('company_id', companyId),
      buscarExecucaoMaisRecente(campanhaId, companyId),
    ])
    if (waErr) throw waErr

    let porInstancia = []
    if (execucao) {
      const detalhes = await montarContadoresPorStatus(execucao.id, companyId)
      porInstancia = detalhes.por_instancia
    }
    const statsMap = porInstancia.reduce((m, i) => {
      m[i.instancia_id] = i
      return m
    }, {})

    const waMap = (wa ?? []).reduce((m, i) => {
      m[i.id] = i
      return m
    }, {})

    const instancias = (configs ?? []).map((cfg) => {
      const inst = waMap[cfg.instancia_id] ?? {}
      const stats = statsMap[cfg.instancia_id]
      return {
        instancia_id: cfg.instancia_id,
        ordem: cfg.ordem,
        ativa_na_campanha: cfg.ativa,
        nome: inst.nome ?? `#${cfg.instancia_id}`,
        status: inst.status ?? 'unknown',
        ativo: inst.ativo ?? false,
        conectada: inst.status === 'connected' && inst.ativo === true,
        display_phone: inst.display_phone ?? inst.telefone_conectado ?? null,
        fila: stats
          ? { total: stats.total, por_status: stats.por_status }
          : { total: 0, por_status: {} },
      }
    })

    res.json({
      campanha_id: campanhaId,
      campanha_status: campanha.status,
      execucao_id: execucao?.id ?? null,
      instancias,
    })
  } catch (err) {
    console.error('[disparo:execucao] saudeInstancias', err)
    res.status(500).json({ error: 'Erro ao consultar saúde das instâncias.' })
  }
}

// ─── 12. Saúde worker ────────────────────────────────────────────────────────

exports.saudeWorker = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return

    const saude = await avaliarSaudeWorker()

    res.json({
      flags: saude.flags,
      janela_minutos: saude.janela_minutos,
      janela_ativo_segundos: saude.janela_ativo_segundos,
      status: saude.status,
      saudavel: saude.saudavel,
      motivo: saude.motivo,
      workers: saude.workers,
      workers_ativos: saude.workers_ativos,
      workers_live_ativos: saude.workers_live_ativos,
      workers_dry_ativos: saude.workers_dry_ativos,
      saudavel_live: saude.saudavel_live,
      modos_divergentes: saude.modos_divergentes,
      ultimo_heartbeat_em: saude.ultimo_heartbeat_em,
    })
  } catch (err) {
    console.error('[disparo:execucao] saudeWorker', err)
    res.status(500).json({ error: 'Erro ao consultar saúde do worker.' })
  }
}

// ─── Exports internos (testes) ───────────────────────────────────────────────

exports._montarContadoresPorStatus = montarContadoresPorStatus
exports._assertCampanhaIniciavel = assertCampanhaIniciavel
exports._validarAgendamento = validarAgendamento
