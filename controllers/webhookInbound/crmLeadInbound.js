/**
 * Captura de lead no CRM Avançado a partir do inbound (best-effort, fire-and-forget).
 * Extraído verbatim de receberZapi (Fase 5 — doc 24). O chamador só invoca quando é conversa nova
 * individual iniciada pelo cliente: `!isGroup && !fromMe && cliente_id`. Espelha o lead fora do
 * caminho quente (setImmediate). Não bloqueia o webhook.
 */

const crmSync = require('../../services/crmSyncService')
const { getCanonicalPhone } = require('../../helpers/conversationSync')

function scheduleInboundLeadCapture({ companyId, conversaId, nomeParaCache, senderName, chatName, phone }) {
  const leadNome = (nomeParaCache && String(nomeParaCache).trim())
    || (senderName && String(senderName).trim())
    || (chatName && String(chatName).trim())
    || null
  const leadTelefone = getCanonicalPhone(phone) || null
  setImmediate(() => {
    crmSync.syncLead({
      empresaId: companyId,
      leadId: conversaId,
      nome: leadNome || leadTelefone || String(conversaId),
      telefone: leadTelefone,
      origemNome: 'WhatsApp',
    })
  })
}

module.exports = { scheduleInboundLeadCapture }
