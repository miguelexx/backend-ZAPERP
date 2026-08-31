/**
 * Enriquecimento de mensagens com autor/usuário e tratamento de "apagada para todos".
 * Extraído de controllers/chatController.js (Fase 4 da modularização) sem alteração de comportamento.
 * As funções que tocam o banco recebem `supabase` por parâmetro (como no original).
 */

const { normalizarTimestampSemFusoAmbiguoParaApi } = require('../../../helpers/timestampApiCompat')
const { formatTextoWhatsappComNomeAtendente } = require('../../../helpers/mensagemAtendenteNomeHelper')

function textoRevogadoApagadaParaTodos(m, viewerUserId) {
  const souAutor =
    m?.autor_usuario_id != null &&
    viewerUserId != null &&
    Number(m.autor_usuario_id) === Number(viewerUserId)
  return souAutor ? 'Você apagou esta mensagem para todos.' : 'Esta mensagem foi apagada para todos.'
}

function aplicarApagadaParaTodosNaMensagem(m, viewerUserId) {
  if (!m?.apagada_para_todos) return m
  return {
    ...m,
    apagada_para_todos: true,
    texto: textoRevogadoApagadaParaTodos(m, viewerUserId),
    reply_meta: null,
    mensagem_respondida_id: null,
  }
}

async function enrichMensagensComAutorUsuario(supabase, company_id, mensagens, viewerUserId = null) {
  if (!Array.isArray(mensagens) || mensagens.length === 0) return mensagens
  const autorIds = [...new Set(mensagens.map((m) => m.autor_usuario_id).filter(Boolean))]
  const decorate = (m, usuarioNome) => {
    let row = {
      ...m,
      criado_em: normalizarTimestampSemFusoAmbiguoParaApi(m.criado_em),
      usuario_id: m.autor_usuario_id ?? null,
      usuario_nome: usuarioNome,
      enviado_por_usuario: m.direcao === 'out' && m.autor_usuario_id != null,
    }
    if (viewerUserId != null) row = aplicarApagadaParaTodosNaMensagem(row, viewerUserId)
    return row
  }
  if (autorIds.length === 0) return mensagens.map((m) => decorate(m, null))
  const { data: us } = await supabase.from('usuarios').select('id, nome').eq('company_id', company_id).in('id', autorIds)
  const usuarioMap = new Map((us || []).map((u) => [u.id, u.nome]))
  return mensagens.map((m) =>
    decorate(
      m,
      m.direcao === 'out' && m.autor_usuario_id ? (usuarioMap.get(m.autor_usuario_id) ?? null) : null
    )
  )
}

/** Texto ao WhatsApp com *nome* na primeira linha (respeita getUsuarioParaEnvioCliente). CRM grava sem prefixo. */
function textoParaEnvioWhatsapp(texto, usuarioNome) {
  return formatTextoWhatsappComNomeAtendente(texto, usuarioNome)
}

function prefixarParaCliente(texto, usuarioNome) {
  return formatTextoWhatsappComNomeAtendente(texto, usuarioNome)
}

/** Busca nome e preferência do usuário para exibir ao cliente no WhatsApp. Retorna { nome, mostrar } */
async function getUsuarioParaEnvioCliente(supabase, company_id, user_id) {
  if (!user_id) return { nome: null, mostrar: false }
  const { data, error } = await supabase.from('usuarios').select('nome, mostrar_nome_ao_cliente').eq('company_id', company_id).eq('id', user_id).maybeSingle()
  if (error) return { nome: null, mostrar: true }
  const mostrar = data?.mostrar_nome_ao_cliente !== false
  const nome = (data?.nome && String(data.nome).trim()) || null
  return { nome: mostrar ? nome : null, mostrar }
}

/** Enriquece uma mensagem única com usuario_nome (para evento nova_mensagem) */
async function enrichMensagemComAutorUsuario(supabase, company_id, msg) {
  const isOut = msg?.direcao === 'out'
  if (!msg || !isOut || !msg.autor_usuario_id) {
    return {
      ...msg,
      criado_em: normalizarTimestampSemFusoAmbiguoParaApi(msg?.criado_em),
      usuario_id: msg?.autor_usuario_id ?? null,
      usuario_nome: null,
      enviado_por_usuario: !!(isOut && msg?.autor_usuario_id),
      // fromMe: mensagens enviadas pelo CRM (direcao 'out') são sempre fromMe=true para fins de notificação.
      // O frontend NÃO deve exibir notificação/som para estas mensagens.
      fromMe: isOut,
    }
  }
  const { data: u } = await supabase.from('usuarios').select('id, nome').eq('company_id', company_id).eq('id', msg.autor_usuario_id).maybeSingle()
  return {
    ...msg,
    criado_em: normalizarTimestampSemFusoAmbiguoParaApi(msg?.criado_em),
    usuario_id: msg.autor_usuario_id,
    usuario_nome: u?.nome ?? null,
    enviado_por_usuario: true,
    fromMe: true,
    apagada_para_todos: msg?.apagada_para_todos === true,
  }
}

module.exports = {
  textoRevogadoApagadaParaTodos,
  aplicarApagadaParaTodosNaMensagem,
  enrichMensagensComAutorUsuario,
  textoParaEnvioWhatsapp,
  prefixarParaCliente,
  getUsuarioParaEnvioCliente,
  enrichMensagemComAutorUsuario,
}
