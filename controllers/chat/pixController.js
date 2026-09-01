/**
 * Pix da empresa: ler/gravar empresa_pix_config e enviar mensagem Pix.
 * Extraído de controllers/chatController.js (modularização) sem alteração de comportamento.
 * Reexportado pela fachada controllers/chatController.js.
 */

const supabase = require('../../config/supabase')
const { sanitizePixConfigPayload, buildPixMessageFromConfig } = require('../../services/chat/outbound/pixConfig')
// enviarMensagemPix monta o texto do Pix e delega ao envio de texto (mesmo pipeline).
const { enviarMensagemChat } = require('./textMessageController')

exports.getPixConfig = async (req, res) => {
  try {
    const { company_id } = req.user
    const { data, error } = await supabase
      .from('empresa_pix_config')
      .select('tipo_chave, chave_pix, nome_recebedor, mensagem_padrao, atualizado_em')
      .eq('company_id', Number(company_id))
      .maybeSingle()

    if (error) {
      const msg = String(error.message || '')
      if (msg.includes('empresa_pix_config') || msg.includes('does not exist')) {
        return res.json({ configured: false, config: null })
      }
      console.error('[chatController] getPixConfig', error?.message)
      return res.status(500).json({ error: 'Erro interno' })
    }

    if (!data) return res.json({ configured: false, config: null })
    return res.json({ configured: true, config: data })
  } catch (err) {
    console.error('[getPixConfig]', err)
    return res.status(500).json({ error: 'Erro ao obter configuração Pix.' })
  }
}

/** PUT /chats/pix-config */
exports.putPixConfig = async (req, res) => {
  try {
    const { company_id, id: user_id } = req.user
    const parsed = sanitizePixConfigPayload(req.body)
    if (!parsed.ok) return res.status(parsed.status).json({ error: parsed.error })

    const payload = {
      company_id: Number(company_id),
      ...parsed.data,
      atualizado_por: Number(user_id),
      atualizado_em: new Date().toISOString(),
    }

    const { data, error } = await supabase
      .from('empresa_pix_config')
      .upsert(payload, { onConflict: 'company_id' })
      .select('tipo_chave, chave_pix, nome_recebedor, mensagem_padrao, atualizado_em')
      .single()

    if (error) {
      const msg = String(error.message || '')
      if (msg.includes('empresa_pix_config') || msg.includes('does not exist') || msg.includes('schema cache')) {
        return res.status(400).json({
          error: 'Funcionalidade Pix ainda não habilitada no banco. Aplique a migration 20260427233000_empresa_pix_config.sql e tente novamente.'
        })
      }
      console.error('[chatController] putPixConfig', error?.message)
      return res.status(500).json({ error: 'Erro interno' })
    }
    return res.json({ ok: true, config: data })
  } catch (err) {
    console.error('[putPixConfig]', err)
    return res.status(500).json({ error: 'Erro ao salvar configuração Pix.' })
  }
}

/** POST /chats/:id/pix — envia mensagem Pix usando o mesmo fluxo de envio/realtime existente */
exports.enviarMensagemPix = async (req, res) => {
  try {
    const { company_id } = req.user
    const { data, error } = await supabase
      .from('empresa_pix_config')
      .select('tipo_chave, chave_pix, nome_recebedor, mensagem_padrao')
      .eq('company_id', Number(company_id))
      .maybeSingle()

    if (error) {
      const msg = String(error.message || '')
      if (msg.includes('empresa_pix_config') || msg.includes('does not exist') || msg.includes('schema cache')) {
        return res.status(400).json({
          error: 'Funcionalidade Pix ainda não habilitada no banco. Aplique a migration 20260427233000_empresa_pix_config.sql.'
        })
      }
      console.error('[chatController] enviarMensagemPix', error?.message)
      return res.status(500).json({ error: 'Erro interno' })
    }
    if (!data) return res.status(400).json({ error: 'Pix não configurado para esta empresa.' })

    const mensagem = buildPixMessageFromConfig(data)
    req.body = { ...req.body, texto: mensagem }
    return enviarMensagemChat(req, res)
  } catch (err) {
    console.error('[enviarMensagemPix]', err)
    return res.status(500).json({ error: 'Erro ao enviar mensagem Pix.' })
  }
}
