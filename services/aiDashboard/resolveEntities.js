'use strict'

const supabase = require('../../config/supabase')
const { normalizeSearchTerm } = require('./searchText')
const { escapeIlikePattern, quoteOrValue } = require('../../helpers/chatSearchHelper')

/** Desambiguação de atendentes por nome (máx. 8 candidatos). */
async function resolveUsuarioCandidates(company_id, nome) {
  if (!nome || !String(nome).trim()) return { id: null, candidatos: [], ambiguous: false }
  const term = `%${normalizeSearchTerm(String(nome).trim())}%`
  const { data } = await supabase
    .from('usuarios')
    .select('id, nome')
    .eq('company_id', company_id)
    .ilike('nome', term)
    .order('nome', { ascending: true })
    .limit(8)
  const list = data || []
  if (!list.length) return { id: null, candidatos: [], ambiguous: false }
  if (list.length === 1) return { id: list[0].id, candidatos: list, ambiguous: false }
  const target = normalizeSearchTerm(String(nome).trim())
  const exact = list.find((u) => normalizeSearchTerm(u.nome || '') === target)
  if (exact) return { id: exact.id, candidatos: list, ambiguous: false }
  return { id: null, candidatos: list, ambiguous: true }
}

/** Desambiguação de clientes por nome/pushname ou telefone. */
async function resolveClienteCandidates(company_id, clienteNome, clienteTelefone) {
  if (clienteTelefone && String(clienteTelefone).trim()) {
    const digits = String(clienteTelefone).replace(/\D/g, '')
    // Telefone com máscara ("+55 (34) 9991-1246") traz parênteses, que são controle no
    // `.or()`. `digits` já era seguro; o valor bruto não era.
    const condicoes = [`telefone.eq.${quoteOrValue(String(clienteTelefone))}`]
    // Sem dígito algum o sufixo viraria o padrão `%`, que casa com QUALQUER telefone —
    // a IA receberia 3 clientes aleatórios como "candidatos".
    if (digits) condicoes.push(`telefone.like.${quoteOrValue(`%${digits.slice(-8)}`)}`)
    const { data: cl } = await supabase
      .from('clientes')
      .select('id, nome, pushname, telefone')
      .eq('company_id', company_id)
      .or(condicoes.join(','))
      .limit(3)
    if (!cl?.length) return { id: null, candidatos: [], ambiguous: false }
    if (cl.length === 1) return { id: cl[0].id, candidatos: cl, ambiguous: false }
    return { id: null, candidatos: cl, ambiguous: true }
  }
  if (!clienteNome || !String(clienteNome).trim()) return { id: null, candidatos: [], ambiguous: false }
  // `normalizeSearchTerm` só tira acento/caixa — não trata vírgula nem parênteses, que são
  // sintaxe do `.or()`. Daí escapar o curinga e citar o valor antes de montar a expressão.
  const term = quoteOrValue(`%${escapeIlikePattern(normalizeSearchTerm(String(clienteNome).trim()))}%`)
  const { data } = await supabase
    .from('clientes')
    .select('id, nome, pushname, telefone')
    .eq('company_id', company_id)
    .or(`nome.ilike.${term},pushname.ilike.${term}`)
    .order('nome', { ascending: true })
    .limit(8)
  const list = data || []
  if (!list.length) return { id: null, candidatos: [], ambiguous: false }
  if (list.length === 1) return { id: list[0].id, candidatos: list, ambiguous: false }
  const target = normalizeSearchTerm(String(clienteNome).trim())
  const exact = list.find((c) => {
    const n = normalizeSearchTerm(c.nome || '')
    const p = normalizeSearchTerm(c.pushname || '')
    return n === target || p === target
  })
  if (exact) return { id: exact.id, candidatos: list, ambiguous: false }
  return { id: null, candidatos: list, ambiguous: true }
}

module.exports = {
  resolveUsuarioCandidates,
  resolveClienteCandidates,
}
