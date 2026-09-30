/**
 * Encaminhamento de mensagem RECEBIDA para o inbox do CRM Avançado (best-effort, fire-and-forget).
 * Espelha o padrão de crmLeadInbound.js: o orquestrador (receberZapi) só invoca para inbound real
 * (`!fromMe && !isGroup` e mensagem inserida pelo webhook). O POST sai fora do caminho quente
 * (setImmediate) e NUNCA bloqueia/derruba o webhook — services/crmSyncService.forwardInboundMessage
 * já engole qualquer erro e é no-op silencioso quando CRM_INBOUND_URL não está configurada.
 *
 * Grupos são excluídos de propósito (o inbox do CRM é por telefone de cliente; o "telefone" de um
 * grupo é o id do grupo, sem contato individual) — mesma fronteira usada na captura de lead.
 */

const crmSync = require('../../services/crmSyncService')
const { getCanonicalPhone } = require('../../helpers/conversationSync')

/**
 * Mapeia o `tipo` interno do ZapERP (coluna mensagens.tipo) para o enum que o CRM espera:
 *   "texto" | "imagem" | "audio" | "video" | "documento" | "localizacao".
 * Tipos sem correspondência direta (contact, poll, reaction, etc.) caem em "texto" — o CRM
 * ainda recebe o texto/legenda e o messageId, sem inventar um tipo que ele não conhece.
 */
function mapTipo(tipoInterno) {
  switch (String(tipoInterno || '').toLowerCase()) {
    case 'imagem':
    case 'sticker':
      return 'imagem'
    case 'audio':
    case 'voice':
      return 'audio'
    case 'video':
      return 'video'
    case 'arquivo':
      return 'documento'
    case 'location':
      return 'localizacao'
    default:
      return 'texto'
  }
}

/**
 * Agenda o encaminhamento da mensagem recebida ao CRM.
 * @param {{ companyId:number|string, mensagemSalva:object, nome?:string|null, phone?:string|null }} p
 *   - mensagemSalva: a linha persistida (traz id, tipo, url, texto, remetente_telefone).
 *   - phone: telefone do chat (origem canônica do número do cliente).
 */
function scheduleInboundCrmForward({ companyId, mensagemSalva, nome, phone }) {
  if (!companyId || !mensagemSalva) return

  const telefone =
    getCanonicalPhone(phone) ||
    (mensagemSalva.remetente_telefone && String(mensagemSalva.remetente_telefone).trim()) ||
    (phone && String(phone).trim()) ||
    null
  if (!telefone) return

  const tipo = mapTipo(mensagemSalva.tipo)
  const midiaUrl = (mensagemSalva.url && String(mensagemSalva.url).trim()) || null
  const mensagem = (mensagemSalva.texto && String(mensagemSalva.texto).trim()) || ''
  const nomeContato = (nome && String(nome).trim()) || null
  const messageId = mensagemSalva.id != null ? String(mensagemSalva.id) : null

  setImmediate(() => {
    crmSync.forwardInboundMessage({
      companyId,
      telefone,
      nome: nomeContato,
      mensagem,
      tipo,
      midiaUrl,
      messageId,
      fromMe: false,
    })
  })
}

module.exports = { scheduleInboundCrmForward, mapTipo }
