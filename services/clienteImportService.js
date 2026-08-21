/**
 * Execução da importação de clientes por planilha.
 *
 * Recebe o plano já validado (helpers/clienteImportPlanner) e persiste no banco
 * REUTILIZANDO a infraestrutura existente:
 *  - getOrCreateCliente(): dedup por telefone + isolamento por company_id, e NUNCA
 *    cria conversa/atendimento (apenas a tabela `clientes`).
 *  - tabela `tags`  (UNIQUE company_id,nome) → cria a série se não existir, reusa se existir.
 *  - tabela `cliente_tags` (UNIQUE company_id,cliente_id,tag_id) → vincula sem duplicar.
 *
 * "Transação segura": o PostgREST/Supabase não expõe transação multi-tabela por este
 * cliente, então a segurança contra cadastros parciais vem da IDEMPOTÊNCIA — todas as
 * operações usam UNIQUE + upsert/ignoreDuplicates, de modo que reexecutar a importação
 * não gera duplicatas. Falhas isoladas por contato são coletadas e reportadas sem
 * interromper o restante do lote.
 */

const { getOrCreateCliente } = require('../helpers/conversationSync')

/**
 * Cria (ou reutiliza) a tag da série para a empresa. Cacheia por nome normalizado.
 * @returns {Promise<{ id:number|null, criada:boolean }>}
 */
async function getOrCreateTag(supabase, companyId, nomeTag, cache) {
  const nome = String(nomeTag || '').replace(/\s+/g, ' ').trim()
  if (!nome) return { id: null, criada: false }

  const cacheKey = nome.toLowerCase()
  // Cache guarda só o id: um hit significa que a tag JÁ foi resolvida antes neste
  // lote, então nunca é "criada" nesta chamada (evita recontar tagsCriadas).
  if (cache.has(cacheKey)) return { id: cache.get(cacheKey), criada: false }

  // 1) já existe?
  const { data: existente } = await supabase
    .from('tags')
    .select('id')
    .eq('company_id', companyId)
    .eq('nome', nome)
    .maybeSingle()

  if (existente?.id) {
    cache.set(cacheKey, existente.id)
    return { id: existente.id, criada: false }
  }

  // 2) cria
  const { data: nova, error } = await supabase
    .from('tags')
    .insert({ nome, cor: null, company_id: companyId })
    .select('id')
    .single()

  if (!error && nova?.id) {
    cache.set(cacheKey, nova.id)
    return { id: nova.id, criada: true }
  }

  // 3) corrida (23505) ou índice único → rebusca
  const { data: refetch } = await supabase
    .from('tags')
    .select('id')
    .eq('company_id', companyId)
    .eq('nome', nome)
    .maybeSingle()

  if (refetch?.id) {
    cache.set(cacheKey, refetch.id)
    return { id: refetch.id, criada: false }
  }

  throw new Error(`Não foi possível criar/obter a tag "${nome}"`)
}

/**
 * Torna as etiquetas do cliente IGUAIS às da planilha (planilha manda): remove os vínculos que
 * não estão no conjunto-alvo e adiciona os que faltam. Assim, quando um aluno passa de "5º Ano"
 * para "8º Ano", a etiqueta antiga sai e não fica "aparecendo duas".
 *
 * Guarda de segurança: só remove quando a linha da planilha trouxe PELO MENOS uma etiqueta.
 * Linha sem etiqueta não apaga o que já existe — evita zerar todo mundo por uma planilha
 * incompleta/sem a coluna de série.
 *
 * @returns {Promise<{ vinculadas:number, removidas:number }>}
 */
async function syncClienteTags(supabase, companyId, clienteId, targetTagIds) {
  const alvo = new Set(
    (Array.isArray(targetTagIds) ? targetTagIds : [])
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id))
  )
  let vinculadas = 0
  let removidas = 0

  const { data: atuaisRows } = await supabase
    .from('cliente_tags')
    .select('tag_id')
    .eq('company_id', companyId)
    .eq('cliente_id', clienteId)

  const atuais = new Set((Array.isArray(atuaisRows) ? atuaisRows : []).map((r) => Number(r.tag_id)))

  // Remove as que não estão na planilha (apenas quando a planilha trouxe etiquetas).
  if (alvo.size > 0) {
    const remover = [...atuais].filter((id) => !alvo.has(id))
    if (remover.length > 0) {
      const { error } = await supabase
        .from('cliente_tags')
        .delete()
        .eq('company_id', companyId)
        .eq('cliente_id', clienteId)
        .in('tag_id', remover)
      if (!error) removidas += remover.length
    }
  }

  // Adiciona as que faltam.
  for (const tagId of alvo) {
    if (atuais.has(tagId)) continue
    if (await linkClienteTag(supabase, companyId, clienteId, tagId)) vinculadas++
  }

  return { vinculadas, removidas }
}

/**
 * Vincula a tag ao cliente se ainda não estiver vinculada.
 * @returns {Promise<boolean>} true se um novo vínculo foi criado
 */
async function linkClienteTag(supabase, companyId, clienteId, tagId) {
  const { data: existente } = await supabase
    .from('cliente_tags')
    .select('id')
    .eq('company_id', companyId)
    .eq('cliente_id', clienteId)
    .eq('tag_id', tagId)
    .maybeSingle()

  if (existente?.id) return false

  const { error } = await supabase
    .from('cliente_tags')
    .insert({ company_id: companyId, cliente_id: clienteId, tag_id: tagId })

  if (error) {
    // Conflito de unicidade (corrida) → considera já vinculado, não é erro real
    if (String(error.code || '') === '23505') return false
    throw error
  }
  return true
}

/**
 * Executa a importação de um plano.
 *
 * @param {object} supabase
 * @param {number} companyId
 * @param {{ entries: Array, ignored: Array, conflicts: Array, stats: object }} plano
 * @returns {Promise<object>} resumo da importação
 */
async function executarImportacao(supabase, companyId, plano) {
  const cid = Number(companyId)
  if (!Number.isFinite(cid) || cid <= 0) {
    throw new Error('company_id inválido')
  }

  const entries = Array.isArray(plano?.entries) ? plano.entries : []
  const tagCache = new Map()

  let clientesImportados = 0
  let clientesJaExistentes = 0
  let tagsVinculadas = 0
  let tagsCriadas = 0
  let tagsRemovidas = 0
  const falhas = []

  for (const entry of entries) {
    try {
      // 1) cliente (dedup + isolamento por empresa; nomeSource 'import' = baixa prioridade,
      //    nunca sobrescreve um nome bom já existente — só preenche se estiver vazio)
      const { cliente_id: clienteId, created } = await getOrCreateCliente(
        supabase,
        cid,
        entry.telefone,
        { nome: entry.nome, nomeSource: 'import' }
      )

      if (!clienteId) {
        falhas.push({
          telefone: entry.telefone,
          nome: entry.nome,
          motivo: 'Não foi possível cadastrar/localizar o cliente',
        })
        continue
      }

      if (created === true) clientesImportados++
      else clientesJaExistentes++

      // 2) tags das séries → a planilha manda: cliente fica só com as etiquetas da linha atual.
      //    Resolve os ids-alvo (criando as que faltam) e depois sincroniza (remove as antigas
      //    que saíram da planilha + adiciona as novas). Assim 5º→8º não deixa etiqueta órfã.
      const targetTagIds = []
      for (const nomeTag of entry.tags || []) {
        try {
          const { id: tagId, criada } = await getOrCreateTag(supabase, cid, nomeTag, tagCache)
          if (!tagId) continue
          if (criada) tagsCriadas++
          targetTagIds.push(tagId)
        } catch (tagErr) {
          falhas.push({
            telefone: entry.telefone,
            nome: entry.nome,
            motivo: `Erro ao resolver tag "${nomeTag}": ${tagErr.message || tagErr}`,
          })
        }
      }

      try {
        const { vinculadas, removidas } = await syncClienteTags(supabase, cid, clienteId, targetTagIds)
        tagsVinculadas += vinculadas
        tagsRemovidas += removidas
      } catch (syncErr) {
        falhas.push({
          telefone: entry.telefone,
          nome: entry.nome,
          motivo: `Erro ao sincronizar etiquetas: ${syncErr.message || syncErr}`,
        })
      }
    } catch (err) {
      falhas.push({
        telefone: entry.telefone,
        nome: entry.nome,
        motivo: `Erro ao importar: ${err.message || err}`,
      })
    }
  }

  return {
    ok: true,
    resumo: {
      totalLinhas: plano?.stats?.totalLinhas ?? 0,
      linhasValidas: plano?.stats?.validas ?? 0,
      telefonesUnicos: entries.length,
      clientesImportados,
      clientesJaExistentes,
      tagsCriadas,
      tagsVinculadas,
      tagsRemovidas,
      linhasIgnoradas: Array.isArray(plano?.ignored) ? plano.ignored.length : 0,
      conflitos: Array.isArray(plano?.conflicts) ? plano.conflicts.length : 0,
      falhas: falhas.length,
    },
    ignored: Array.isArray(plano?.ignored) ? plano.ignored : [],
    conflicts: Array.isArray(plano?.conflicts) ? plano.conflicts : [],
    falhas,
  }
}

module.exports = {
  executarImportacao,
  getOrCreateTag,
  linkClienteTag,
  syncClienteTags,
}
