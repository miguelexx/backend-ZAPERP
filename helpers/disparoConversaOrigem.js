/**
 * Classificação de conversas originadas pelo módulo Disparo/Campanhas.
 * Sem I/O — regras puras para persistir, filtrar e pular o chatbot
 * somente quando a conversa está aguardando a primeira resposta da campanha.
 */

const STATUS_ATENDIMENTO_HUMANO_ATIVO = new Set([
  'em_atendimento',
  'aguardando_cliente',
  'pagamento_pendente',
  'em_atraso',
])

function isMissingAguardandoCampanhaColumn(err) {
  if (!err) return false
  const code = String(err.code || '')
  const msg = String(err.message || err.details || '')
  return (
    code === 'PGRST204' ||
    code === '42703' ||
    /aguardando_resposta_campanha/i.test(msg)
  )
}

function isGrupoConversa(conversa) {
  if (!conversa) return false
  if (conversa.is_group === true) return true
  const tipo = String(conversa.tipo || '').trim().toLowerCase()
  if (tipo === 'grupo') return true
  return String(conversa.telefone || '').includes('@g.us')
}

function statusAtendimentoNorm(conversa) {
  return String(conversa?.status_atendimento || '').trim().toLowerCase()
}

/**
 * Atendimento humano já em curso: não reclassificar para o filtro Campanhas.
 * Atendente leftover em conversa aberta/fechada NÃO conta — o disparo deve
 * ir para Campanhas até o contato responder.
 */
function atendimentoHumanoAtivo(conversa) {
  if (!conversa || isGrupoConversa(conversa)) return false
  return STATUS_ATENDIMENTO_HUMANO_ATIVO.has(statusAtendimentoNorm(conversa))
}

function deveMarcarAguardandoCampanha(conversa) {
  if (!conversa) return true
  if (isGrupoConversa(conversa)) return false
  if (atendimentoHumanoAtivo(conversa)) return false
  return true
}

function devePularChatbotPorCampanha(conversa) {
  return conversa?.aguardando_resposta_campanha === true && !isGrupoConversa(conversa)
}

function visivelNoFiltroCampanhas(conversa) {
  if (!conversa || isGrupoConversa(conversa)) return false
  return conversa.aguardando_resposta_campanha === true
}

function visivelNaMinhaFilaQuantoACampanha(conversa) {
  if (!conversa) return true
  return conversa.aguardando_resposta_campanha !== true
}

module.exports = {
  STATUS_ATENDIMENTO_HUMANO_ATIVO,
  isMissingAguardandoCampanhaColumn,
  isGrupoConversa,
  atendimentoHumanoAtivo,
  deveMarcarAguardandoCampanha,
  devePularChatbotPorCampanha,
  visivelNoFiltroCampanhas,
  visivelNaMinhaFilaQuantoACampanha,
}
