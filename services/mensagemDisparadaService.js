/**
 * Módulo "Separar mensagens disparadas" — aplicação da classificação por TAMANHO (com I/O).
 *
 * Ponto ÚNICO no backend que persiste `status_atendimento = 'mensagem_disparada'` a partir da regra
 * de tamanho e emite o realtime que move a conversa de "Abertas" para "Mensagens Disparadas".
 * Chamado por:
 *   - controllers/chat/textMessageController.js  → envio manual pelo CRM (estado capturado ANTES do auto-assumir)
 *   - controllers/webhookZapiController.js        → envio externo (pelo celular, fromMe sem autor); estado atual confiável
 *
 * Idempotente. As regras puras vivem em helpers/mensagemDisparadaClassificacao.js (sem duplicar no frontend).
 */

const supabase = require('../config/supabase')
const {
  deveClassificarComoMensagemDisparada,
  textoExcedeLimiteDisparo,
} = require('../helpers/mensagemDisparadaClassificacao')

function isGrupoPorTipoTelefone(tipo, telefone) {
  return String(tipo || '').toLowerCase() === 'grupo' || String(telefone || '').includes('@g.us')
}

/** `true` se a conversa já tem alguma mensagem inbound (cliente já falou). */
async function conversaTemInbound(companyId, conversaId) {
  const cid = Number(companyId)
  const convId = Number(conversaId)
  if (!cid || !convId) return false
  try {
    const { count, error } = await supabase
      .from('mensagens')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', cid)
      .eq('conversa_id', convId)
      .eq('direcao', 'in')
    if (error) return false
    return Number(count || 0) > 0
  } catch (_) {
    return false
  }
}

/** Estado atual confiável da conversa (caminho externo/webhook, sem auto-assumir). */
async function carregarEstadoConversa(companyId, conversaId) {
  const cid = Number(companyId)
  const convId = Number(conversaId)
  if (!cid || !convId) return null
  const { data, error } = await supabase
    .from('conversas')
    .select('id, status_atendimento, atendente_id, tipo, telefone, aguardando_resposta_campanha')
    .eq('company_id', cid)
    .eq('id', convId)
    .maybeSingle()
  if (error || !data) return null
  return {
    statusAntes: data.status_atendimento ?? null,
    atendenteAntes: data.atendente_id ?? null,
    isGroup: isGrupoPorTipoTelefone(data.tipo, data.telefone),
    aguardandoRespostaCampanha: data.aguardando_resposta_campanha === true,
  }
}

/**
 * Captura o estado ANTES do envio manual (antes do auto-assumir da política de envio),
 * para o caminho do CRM. Inclui histórico de inbound.
 */
async function capturarEstadoConversaAntesDisparo(companyId, conversaId) {
  const cid = Number(companyId)
  const convId = Number(conversaId)
  if (!cid || !convId) return null
  const [estado, temInbound] = await Promise.all([
    carregarEstadoConversa(cid, convId),
    conversaTemInbound(cid, convId),
  ])
  if (!estado) return null
  return { ...estado, temInbound }
}

function emitirConversaVirouDisparada(io, companyId, conversaId, agora) {
  if (!io) return
  const cid = Number(conversaId)
  const company = Number(companyId)
  const payload = {
    id: cid,
    company_id: company,
    status_atendimento: 'mensagem_disparada',
    status_atendimento_real: 'mensagem_disparada',
    atendente_id: null,
    exibir_badge_aberta: false,
    ultima_atividade: agora,
    // Hint para o frontend realinhar lista + contadores (mesma convenção do fluxo de campanhas).
    lista_realtime: { minha_fila: true, motivo: 'mensagem_disparada' },
  }
  try {
    io.to(`empresa_${company}`).to(`conversa_${cid}`).emit('conversa_atualizada', payload)
  } catch (e) {
    console.warn('[mensagem_disparada] emit conversa_atualizada:', e?.message || e)
  }
}

/**
 * Classifica um OUTBOUND (>600 chars, módulo ativo) como status_atendimento='mensagem_disparada'.
 * Idempotente. Recebe o estado ANTERIOR ao envio (CRM) OU carrega o estado atual (webhook externo,
 * via `carregarEstadoAtual: true`).
 *
 * @returns {Promise<{ok:boolean, classified?:boolean, ignored?:string, conversa_id?:number}>}
 */
async function classificarSaidaComoMensagemDisparada({
  companyId,
  conversaId,
  texto,
  separarAtivo,
  isGroup,
  aguardandoRespostaCampanha,
  statusAtendimentoAntes,
  atendenteIdAntes,
  temInbound,
  carregarEstadoAtual = false,
  io = null,
} = {}) {
  const cid = Number(companyId)
  const convId = Number(conversaId)
  if (!cid || !convId) return { ok: false, ignored: 'params_invalidos' }
  if (separarAtivo !== true) return { ok: true, classified: false, ignored: 'modulo_desativado' }
  // Gate barato antes de qualquer I/O adicional: só mensagens realmente longas seguem.
  if (!textoExcedeLimiteDisparo(texto)) return { ok: true, classified: false, ignored: 'tamanho' }

  let estado = {
    isGroup: isGroup === true,
    aguardandoRespostaCampanha: aguardandoRespostaCampanha === true,
    statusAntes: statusAtendimentoAntes ?? null,
    atendenteAntes: atendenteIdAntes ?? null,
    temInbound,
  }

  if (carregarEstadoAtual) {
    const carregado = await carregarEstadoConversa(cid, convId)
    if (!carregado) return { ok: true, classified: false, ignored: 'conversa_nao_encontrada' }
    estado = {
      isGroup: carregado.isGroup,
      aguardandoRespostaCampanha: carregado.aguardandoRespostaCampanha,
      statusAntes: carregado.statusAntes,
      atendenteAntes: carregado.atendenteAntes,
      temInbound: temInbound == null ? await conversaTemInbound(cid, convId) : temInbound,
    }
  } else if (estado.temInbound == null) {
    estado.temInbound = await conversaTemInbound(cid, convId)
  }

  const deve = deveClassificarComoMensagemDisparada({
    separarAtivo: true,
    direcao: 'out',
    texto,
    isGroup: estado.isGroup,
    aguardandoRespostaCampanha: estado.aguardandoRespostaCampanha,
    statusAtendimentoAntes: estado.statusAntes,
    atendenteIdAntes: estado.atendenteAntes,
    temInbound: estado.temInbound,
  })
  if (!deve) return { ok: true, classified: false, ignored: 'atendimento_humano_ou_regra' }

  const agora = new Date().toISOString()
  const { data: updated, error } = await supabase
    .from('conversas')
    .update({
      status_atendimento: 'mensagem_disparada',
      departamento_id: null,
      atendente_id: null,
      atendente_atribuido_em: null,
      ultima_atividade: agora,
    })
    .eq('id', convId)
    .eq('company_id', cid)
    .select('id, status_atendimento')
    .maybeSingle()

  if (error) {
    console.warn('[mensagem_disparada] update conversa:', error?.message || error)
    return { ok: false, ignored: 'erro_update' }
  }
  if (!updated) return { ok: true, classified: false, ignored: 'nao_atualizada' }

  emitirConversaVirouDisparada(io, cid, convId, agora)
  return { ok: true, classified: true, conversa_id: convId }
}

module.exports = {
  classificarSaidaComoMensagemDisparada,
  capturarEstadoConversaAntesDisparo,
  carregarEstadoConversa,
  conversaTemInbound,
}
