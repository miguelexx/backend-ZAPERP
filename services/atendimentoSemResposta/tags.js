const supabase = require('../../config/supabase')
const { TAG_REABERTA_FALTA_RESPOSTA_COR } = require('./constants')
const { duplicateKeyError } = require('./errors')

async function fetchConversaTagsForRealtime(company_id, conversa_id) {
  const { data, error } = await supabase
    .from('conversa_tags')
    .select('tags ( id, nome, cor )')
    .eq('company_id', company_id)
    .eq('conversa_id', conversa_id)
  if (error) {
    console.warn('[atendimentoSemResposta] fetchConversaTagsForRealtime:', error.message)
    return []
  }
  return (data || []).map((row) => row?.tags).filter(Boolean)
}

async function ensureTagForConversa(company_id, conversa_id, nomeTag) {
  const nome = String(nomeTag || '').trim()
  if (!nome) return null
  const { data: tag, error: tagLookupError } = await supabase
    .from('tags')
    .select('id, nome, cor')
    .eq('company_id', company_id)
    .ilike('nome', nome)
    .maybeSingle()
  if (tagLookupError) {
    console.warn('[atendimentoSemResposta] ensureTagForConversa lookup:', tagLookupError.message)
    return null
  }
  let tagId = tag?.id
  if (!tagId) {
    const { data: created, error: createError } = await supabase
      .from('tags')
      .insert({ company_id, nome, cor: TAG_REABERTA_FALTA_RESPOSTA_COR })
      .select('id')
      .single()
    tagId = created?.id
    if (!tagId && createError && duplicateKeyError(createError)) {
      const { data: afterRace } = await supabase
        .from('tags')
        .select('id, nome, cor')
        .eq('company_id', company_id)
        .ilike('nome', nome)
        .maybeSingle()
      tagId = afterRace?.id
    } else if (createError) {
      console.warn('[atendimentoSemResposta] ensureTagForConversa tag:', createError.message)
    }
  } else if (String(tag?.cor || '').toLowerCase() !== TAG_REABERTA_FALTA_RESPOSTA_COR) {
    await supabase
      .from('tags')
      .update({ cor: TAG_REABERTA_FALTA_RESPOSTA_COR })
      .eq('company_id', company_id)
      .eq('id', tagId)
      .catch(() => {})
  }
  if (!tagId) return null
  const { data: existente, error: existenteError } = await supabase
    .from('conversa_tags')
    .select('id')
    .eq('company_id', company_id)
    .eq('conversa_id', conversa_id)
    .eq('tag_id', tagId)
    .maybeSingle()
  if (existenteError) {
    console.warn('[atendimentoSemResposta] ensureTagForConversa existente:', existenteError.message)
  }
  if (!existente) {
    const { error: relError } = await supabase
      .from('conversa_tags')
      .insert({ company_id, conversa_id, tag_id: tagId })
    if (relError && !duplicateKeyError(relError)) {
      console.warn('[atendimentoSemResposta] ensureTagForConversa rel:', relError.message)
    }
  }
  return tagId
}

module.exports = {
  fetchConversaTagsForRealtime,
  ensureTagForConversa,
}
