'use strict'

// Recebe pedidos de envio do CRM Avançado (automação por etapa) e os
// despacha REUTILIZANDO a infraestrutura de envio do ZapERP: instância
// padrão da empresa, provider correto e checagem de opt-out. Não cria
// rotina paralela de WhatsApp.
//
// Autenticação: header x-zaperp-secret === ZAP_SSO_SECRET (mesmo segredo
// do SSO). É server-to-server; não usa o auth (JWT de usuário).

const supabase = require('../config/supabase')
const { getProvider } = require('../services/providers')
const { resolveConversationProvider } = require('../services/chat/identity/conversationAddressService')
const { getDefaultWhatsappInstance } = require('../services/whatsappInstanceService')
const { normalizePhoneBR } = require('../helpers/phoneHelper')

async function estaOptOut(companyId, telefone) {
  try {
    const normalizado = normalizePhoneBR(telefone)
    if (!normalizado) return false
    const { data } = await supabase
      .from('disparo_exclusoes')
      .select('id')
      .eq('company_id', companyId)
      .eq('telefone_normalizado', normalizado)
      .eq('ativo', true)
      .maybeSingle()
    return !!data
  } catch (_err) {
    // Falha ao consultar opt-out não deve derrubar o envio; loga e segue.
    return false
  }
}

async function enviarMensagem(req, res) {
  const segredo = process.env.ZAP_SSO_SECRET
  if (!segredo) {
    return res.status(503).json({ ok: false, error: 'Integração de envio não configurada (ZAP_SSO_SECRET).' })
  }
  if (req.headers['x-zaperp-secret'] !== segredo) {
    return res.status(401).json({ ok: false, error: 'Segredo inválido.' })
  }

  const companyId = Number(req.body?.companyId)
  const telefone = String(req.body?.telefone || '').trim()
  const mensagem = String(req.body?.mensagem || '').trim()
  const referencia = req.body?.referencia ? String(req.body.referencia) : undefined

  if (!Number.isFinite(companyId) || companyId <= 0) {
    return res.status(400).json({ ok: false, error: 'companyId inválido.' })
  }
  if (!telefone || !mensagem) {
    return res.status(400).json({ ok: false, error: 'telefone e mensagem são obrigatórios.' })
  }

  // Opt-out: respeita a lista de exclusões do ZapERP.
  if (await estaOptOut(companyId, telefone)) {
    return res.status(200).json({ ok: false, error: 'Destinatário em opt-out.', optOut: true })
  }

  // Instância padrão ativa da empresa.
  const { instance, error: errInst, code } = await getDefaultWhatsappInstance(companyId)
  if (errInst || !instance) {
    return res.status(409).json({ ok: false, error: errInst || 'Sem instância WhatsApp ativa.', code })
  }

  try {
    const provider = await resolveConversationProvider(companyId, instance.id)
    const adapter = getProvider({ provider })
    const resultado = await adapter.sendText(telefone, mensagem, {
      companyId,
      whatsappInstanceId: instance.id,
      referenceId: referencia,
      returnDetails: true,
    })

    if (resultado === false) {
      return res.status(502).json({ ok: false, error: 'Envio rejeitado pelo provedor.' })
    }
    if (typeof resultado === 'object' && resultado !== null) {
      if (resultado.ok === false) {
        return res.status(502).json({ ok: false, error: resultado.error || 'Falha no envio.' })
      }
      return res.json({ ok: true, messageId: resultado.messageId || resultado.id || null })
    }
    return res.json({ ok: true, messageId: null })
  } catch (err) {
    console.error('[crm:enviar-mensagem] company=', companyId, err?.message)
    return res.status(500).json({ ok: false, error: 'Erro interno ao enviar.' })
  }
}

module.exports = { enviarMensagem }
