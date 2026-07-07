const supabase = require('../config/supabase')
const { empresaModoSimplesAtivo } = require('../helpers/empresaModoSimplesFlag')
const {
  loadChatbotTriageMergeAndAbsence,
  outboundQualificaParaAguardandoCliente,
} = require('./absenceFinalizationService')

const CLOSED_STATUSES = new Set(['fechada', 'finalizada', 'encerrada', 'finalizado'])

function isGroupConversation(conv) {
  if (!conv) return false
  const tipo = String(conv.tipo || '').toLowerCase()
  if (tipo === 'grupo' || tipo === 'group') return true
  const tel = String(conv.telefone || '')
  return tel.includes('@g.us')
}

function isClosedAttendanceStatus(status) {
  const s = status != null ? String(status).toLowerCase().trim().replace(/\s+/g, '_') : ''
  return CLOSED_STATUSES.has(s)
}

function compareMensagemTs(a, b) {
  const ta = new Date(a?.criado_em || 0).getTime()
  const tb = new Date(b?.criado_em || 0).getTime()
  if (ta !== tb) return ta > tb ? 1 : -1
  const ia = Number(a?.id)
  const ib = Number(b?.id)
  if (Number.isFinite(ia) && Number.isFinite(ib) && ia !== ib) return ia > ib ? 1 : -1
  return 0
}

/**
 * Mensagem real que conta para o modo simples (exclui system, bot interno, ausência automática).
 */
async function mensagemQualificaParaModoSimples(msg, company_id, triageAbsenceOpt) {
  if (!msg || !company_id) return false
  const dir = String(msg.direcao || '').toLowerCase().trim()
  if (dir === 'system') return false
  if (dir === 'in') return true
  if (dir !== 'out') return false
  let triageMerged
  let absenceCfg
  if (triageAbsenceOpt) {
    triageMerged = triageAbsenceOpt.triageMerged
    absenceCfg = triageAbsenceOpt.absence
  } else {
    const loaded = await loadChatbotTriageMergeAndAbsence(company_id)
    triageMerged = loaded.triageMerged
    absenceCfg = loaded.absence
  }
  return outboundQualificaParaAguardandoCliente(
    msg.texto,
    msg.autor_usuario_id,
    triageMerged,
    absenceCfg
  )
}

/**
 * Última mensagem real da conversa (inbound ou outbound qualificado).
 */
async function getUltimaMensagemReal(conversa_id, company_id, opts = {}) {
  if (!conversa_id || !company_id) return null
  const { mensagemNova, triageAbsenceOpt } = opts
  const { data: msgs, error } = await supabase
    .from('mensagens')
    .select('id, direcao, criado_em, autor_usuario_id, texto, tipo, conversa_id')
    .eq('conversa_id', Number(conversa_id))
    .eq('company_id', Number(company_id))
    .in('direcao', ['in', 'out'])
    .order('criado_em', { ascending: false })
    .order('id', { ascending: false })
    .limit(50)
  if (error) {
    console.warn('[modoSimples] getUltimaMensagemReal:', error.message || error)
    return null
  }
  const triageLoaded = triageAbsenceOpt || (await loadChatbotTriageMergeAndAbsence(company_id))
  let best = null
  for (const row of msgs || []) {
    if (await mensagemQualificaParaModoSimples(row, company_id, triageLoaded)) {
      best = row
      break
    }
  }
  if (
    mensagemNova &&
    Number(mensagemNova.conversa_id) === Number(conversa_id) &&
    (await mensagemQualificaParaModoSimples(mensagemNova, company_id, triageLoaded))
  ) {
    if (!best || compareMensagemTs(mensagemNova, best) >= 0) return mensagemNova
  }
  return best
}

function resolverModoSimplesAguardando(lastMsg) {
  if (!lastMsg) return null
  const dir = String(lastMsg.direcao || '').toLowerCase().trim()
  if (dir === 'in') return 'atendente'
  if (dir === 'out') return 'cliente'
  return null
}

function aplicarModoSimplesNoPayload(payload, conversaRow, empresaFlag) {
  if (!payload || typeof payload !== 'object') return payload
  const ativo = empresaFlag === true || conversaRow?.atendimento_modo_simples === true
  if (!ativo) return payload
  payload.atendimento_modo_simples = true
  if (conversaRow && Object.prototype.hasOwnProperty.call(conversaRow, 'modo_simples_aguardando')) {
    payload.modo_simples_aguardando = conversaRow.modo_simples_aguardando ?? null
  }
  return payload
}

/**
 * Recalcula modo_simples_aguardando com base na última mensagem real.
 * Não altera atendente_id, departamento_id nem status_atendimento.
 */
async function recalcularStatusPorUltimaMensagem({
  company_id,
  conversa_id,
  mensagemNova = null,
  io = null,
  emitirEvento = null,
}) {
  const cid = Number(company_id)
  const convId = Number(conversa_id)
  if (!Number.isFinite(cid) || !Number.isFinite(convId)) {
    return { changed: false, skipped: true, reason: 'missing_context' }
  }

  const modoSimples = await empresaModoSimplesAtivo(cid)
  if (!modoSimples) {
    return { changed: false, skipped: true, reason: 'modo_simples_desligado' }
  }

  const { data: conv, error: convErr } = await supabase
    .from('conversas')
    .select(
      'id, tipo, telefone, status_atendimento, atendente_id, departamento_id, modo_simples_aguardando, ultima_atividade, aguardando_cliente_desde'
    )
    .eq('company_id', cid)
    .eq('id', convId)
    .maybeSingle()
  if (convErr || !conv) {
    return { changed: false, skipped: true, reason: convErr ? 'db_error' : 'conversa_nao_encontrada' }
  }
  if (isGroupConversation(conv)) {
    return { changed: false, skipped: true, reason: 'grupo' }
  }
  if (isClosedAttendanceStatus(conv.status_atendimento)) {
    return { changed: false, skipped: true, reason: 'conversa_fechada' }
  }

  const lastMsg = await getUltimaMensagemReal(convId, cid, { mensagemNova })
  const novoAguardando = resolverModoSimplesAguardando(lastMsg)
  const anterior = conv.modo_simples_aguardando ?? null

  if (anterior === novoAguardando) {
    return {
      changed: false,
      skipped: false,
      modo_simples_aguardando: novoAguardando,
      ultima_direcao: lastMsg?.direcao ?? null,
      atendimento_modo_simples: true,
    }
  }

  const { error: updErr } = await supabase
    .from('conversas')
    .update({ modo_simples_aguardando: novoAguardando })
    .eq('company_id', cid)
    .eq('id', convId)
  if (updErr) {
    console.warn('[modoSimples] update:', updErr.message || updErr)
    return { changed: false, skipped: false, reason: 'update_failed', error: updErr.message }
  }

  const result = {
    changed: true,
    skipped: false,
    modo_simples_aguardando: novoAguardando,
    ultima_direcao: lastMsg?.direcao ?? null,
    atendimento_modo_simples: true,
    conversa: {
      ...conv,
      modo_simples_aguardando: novoAguardando,
      atendimento_modo_simples: true,
    },
  }

  if (io && typeof emitirEvento === 'function') {
    await emitirEvento(io, cid, convId, result).catch((e) => {
      console.warn('[modoSimples] emit:', e?.message || e)
    })
  }

  return result
}

function isModoSimplesAguardandoAtendenteValor(val) {
  return String(val || '').toLowerCase().trim() === 'atendente'
}

/** Conversa entra na aba Minha fila quando modo simples está ativo (pendência de resposta). */
function conversaEntraMinhaFilaModoSimples(row) {
  if (!row || isGroupConversation(row)) return false
  return isModoSimplesAguardandoAtendenteValor(row.modo_simples_aguardando)
}

/** Filtro SQL da Minha fila no modo simples: só individuais aguardando atendente. */
function applyMinhaFilaModoSimplesSqlFilter(q) {
  return q.or('tipo.is.null,tipo.neq.grupo').eq('modo_simples_aguardando', 'atendente')
}

module.exports = {
  isClosedAttendanceStatus,
  mensagemQualificaParaModoSimples,
  getUltimaMensagemReal,
  resolverModoSimplesAguardando,
  aplicarModoSimplesNoPayload,
  recalcularStatusPorUltimaMensagem,
  empresaModoSimplesAtivo,
  isModoSimplesAguardandoAtendenteValor,
  conversaEntraMinhaFilaModoSimples,
  applyMinhaFilaModoSimplesSqlFilter,
}
