/**
 * Tags de conversa: adicionar e remover etiquetas.
 * Extraído de controllers/chatController.js (modularização) sem alteração de comportamento.
 * Reexportado pela fachada controllers/chatController.js.
 */

const supabase = require('../../config/supabase')
const { assertPermissaoConversa } = require('../../services/chat/access/conversationPolicy')
const { emitirConversaAtualizada, emitirEventoEmpresaConversa } = require('../../services/chat/realtime/chatRealtimeGateway')

async function validarConversa(req, res) {
  const { company_id, id: user_id, perfil, departamento_ids = [] } = req.user
  const perm = await assertPermissaoConversa({
    company_id, conversa_id: req.params.id, user_id, role: perfil, user_dep_ids: departamento_ids,
  })
  if (!perm.ok) res.status(perm.status).json({ error: perm.error })
  return perm.ok
}

exports.adicionarTagConversa = async (req, res) => {
  try {
    const { id } = req.params
    const { tag_id } = req.body
    const { company_id } = req.user

    if (!tag_id) return res.status(400).json({ error: 'tag_id é obrigatório' })
    if (!await validarConversa(req, res)) return

    // FKs simples não garantem que conversa, etiqueta e vínculo pertencem à mesma empresa.
    const { data: tag, error: tagError } = await supabase
      .from('tags').select('id').eq('id', tag_id).eq('company_id', company_id).maybeSingle()
    if (tagError) return res.status(500).json({ error: 'Erro ao validar tag' })
    if (!tag) return res.status(404).json({ error: 'Tag não encontrada' })

    const { data: existente } = await supabase
      .from('conversa_tags')
      .select('id')
      .eq('conversa_id', id)
      .eq('tag_id', tag_id)
      .eq('company_id', company_id)
      .maybeSingle()

    if (existente) return res.status(409).json({ error: 'Tag já vinculada' })

    const { data, error } = await supabase
      .from('conversa_tags')
      .insert([{ conversa_id: id, tag_id, company_id }])
      .select(`
        id,
        tags (
          id,
          nome,
          cor
        )
      `)
      .single()

    if (error?.code === '23505') return res.status(409).json({ error: 'Tag já vinculada' })
    if (error) { console.error('[chatController]', error?.message); return res.status(500).json({ error: 'Erro interno' }) }

    const io = req.app.get('io')
    if (io) {
      const payload = { conversa_id: Number(id), tag: data.tags }

      emitirEventoEmpresaConversa(
        io,
        company_id,
        id,
        io.EVENTS?.TAG_ADICIONADA || 'tag_adicionada',
        payload
      )
      emitirConversaAtualizada(io, company_id, id, { id: Number(id) }, { skipAtualizarConversa: true })
    }

    return res.json({ success: true, tag: data.tags })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao adicionar tag' })
  }
}

exports.removerTagConversa = async (req, res) => {
  try {
    const { id, tag_id } = req.params
    const { company_id } = req.user

    if (!await validarConversa(req, res)) return

    const { error } = await supabase
      .from('conversa_tags')
      .delete()
      .eq('conversa_id', id)
      .eq('tag_id', tag_id)
      .eq('company_id', company_id)

    if (error) { console.error('[chatController]', error?.message); return res.status(500).json({ error: 'Erro interno' }) }

    const io = req.app.get('io')
    if (io) {
      const payload = { conversa_id: Number(id), tag_id: Number(tag_id) }

      emitirEventoEmpresaConversa(
        io,
        company_id,
        id,
        io.EVENTS?.TAG_REMOVIDA || 'tag_removida',
        payload
      )
      emitirConversaAtualizada(io, company_id, id, { id: Number(id) }, { skipAtualizarConversa: true })
    }

    return res.json({ success: true })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao remover tag' })
  }
}
