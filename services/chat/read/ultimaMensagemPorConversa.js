/**
 * ultimaMensagemPorConversa.js — ÚLTIMA mensagem in/out de cada conversa, sem varrer `mensagens`.
 *
 * Doc 29 §3 item 10: `listLastMessagesByConversation` (Supervisão e Minhas Pendências) paginava
 * TODAS as mensagens das conversas abertas com OFFSET (`.range()` de 1000 em 1000) só para ficar
 * com a primeira linha de cada conversa — numa empresa com 300 conversas abertas × milhares de
 * mensagens, isso eram dezenas de páginas por chamada, a cada poll de 30 s.
 *
 * Agora é o mesmo embed lateral da lista de conversas (`conversationListController`):
 * `conversas` → `mensagens(...)` com `order`+`limit(1, { referencedTable })`. O PostgREST
 * compila o embed como `LATERAL (... WHERE conversa_id = conversas.id ORDER BY criado_em DESC
 * LIMIT 1)` — o `limit` é POR CONVERSA, não global — e o filtro `mensagens.company_id`
 * deixa o planner usar `idx_mensagens_company_conversa_criado_id` inteiro.
 *
 * Filtros embutidos (`mensagens.direcao`, `mensagens.criado_em`) entram no mesmo subquery
 * lateral: a mensagem devolvida é a última que SATISFAZ o filtro, não "a última e depois
 * filtra". Sem `!inner`, conversa sem mensagem elegível vem com `mensagens: []` e fica de fora
 * do Map — mesmo comportamento da varredura antiga.
 *
 * Isolamento entre empresas é app-layer (SERVICE_ROLE bypassa RLS): `company_id` filtra o pai
 * E o embed.
 */
const supabase = require('../../../config/supabase')

/** Evita URL/query enorme em `.in()` quando há muitas conversas abertas. */
const CONV_ID_IN_CHUNK = 120

function normalizarIds(conversationIds) {
  return [...new Set(
    (conversationIds || []).map((id) => Number(id)).filter((n) => Number.isFinite(n) && n > 0)
  )]
}

/**
 * @param {number} companyId
 * @param {Array<number|string>} conversationIds
 * @param {object} [opts]
 * @param {string} [opts.colunas] colunas de `mensagens` a devolver (sempre inclui `conversa_id`,
 *   `direcao` e `criado_em`, que os chamadores usam para classificar).
 * @returns {Promise<Map<number, object>>} chave = Number(conversa_id); valor = linha de `mensagens`
 *   no mesmo formato da varredura antiga (objeto plano com as colunas pedidas).
 */
async function listUltimaMensagemPorConversa(companyId, conversationIds, opts = {}) {
  const ids = normalizarIds(conversationIds)
  const map = new Map()
  if (!ids.length) return map

  const colunas = String(opts.colunas || 'conversa_id, direcao, criado_em')

  for (let i = 0; i < ids.length; i += CONV_ID_IN_CHUNK) {
    const slice = ids.slice(i, i + CONV_ID_IN_CHUNK)
    const { data, error } = await supabase
      .from('conversas')
      .select(`id, mensagens ( ${colunas} )`)
      .eq('company_id', companyId)
      .in('id', slice)
      .eq('mensagens.company_id', companyId)
      .in('mensagens.direcao', ['in', 'out'])
      .not('mensagens.criado_em', 'is', null)
      // Supabase-js v2: `referencedTable` ordena/limita a relação (por conversa).
      .order('criado_em', { ascending: false, referencedTable: 'mensagens' })
      .order('id', { ascending: false, referencedTable: 'mensagens' })
      .limit(1, { referencedTable: 'mensagens' })
    if (error) throw error

    for (const conversa of data || []) {
      const cid = Number(conversa?.id)
      if (!Number.isFinite(cid) || map.has(cid)) continue
      const ultima = Array.isArray(conversa.mensagens) ? conversa.mensagens[0] : conversa.mensagens
      if (!ultima) continue
      map.set(cid, { ...ultima, conversa_id: cid })
    }
  }
  return map
}

module.exports = { listUltimaMensagemPorConversa, CONV_ID_IN_CHUNK }
