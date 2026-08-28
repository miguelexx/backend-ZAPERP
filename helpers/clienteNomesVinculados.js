/**
 * Nomes vinculados ao mesmo cliente (irmãos no telefone do responsável).
 * Só a importação por planilha grava. Busca reutiliza search_name_key / prefixo de palavra.
 */

const {
  normalizeNameSearchKey,
  nameMatchesWordPrefix,
  escapeIlikePattern,
  quoteOrValue,
} = require('./chatSearchHelper')

const ORIGEM_PLANILHA = 'planilha'
const TABELA = 'cliente_nomes_vinculados'
const CHUNK = 200

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function normalizeNomeVinculado(nome) {
  return normalizeNameSearchKey(nome)
}

function nomesVinculadosIguais(a, b) {
  const ka = normalizeNomeVinculado(a)
  const kb = normalizeNomeVinculado(b)
  if (ka && kb) return ka === kb
  return cleanText(a).toLowerCase() === cleanText(b).toLowerCase()
}

function nameMatchesUnaccentContains(value, rawTerm) {
  const nameKey = normalizeNameSearchKey(value)
  const termKey = normalizeNameSearchKey(rawTerm)
  if (!nameKey || !termKey) return false
  return nameKey.includes(termKey)
}

function vinculoCasaTermo(vinculo, rawTerm, mode) {
  const nome = vinculo?.nome
  if (mode === 'contains') return nameMatchesUnaccentContains(nome, rawTerm)
  return nameMatchesWordPrefix(nome, rawTerm)
}

/**
 * Demais alunos do telefone (exceto o nome principal já gravado no cliente).
 * Dedup por nome_normalizado; a última série vista prevalece.
 */
function alunosParaVincular(alunos, nomePrincipal) {
  const list = Array.isArray(alunos) ? alunos : []
  const byKey = new Map()
  for (const aluno of list) {
    const nome = cleanText(aluno?.nome)
    if (!nome || nomesVinculadosIguais(nome, nomePrincipal)) continue
    const key = normalizeNomeVinculado(nome)
    if (!key) continue
    const serie = cleanText(aluno?.serie) || null
    byKey.set(key, { nome, serie, nome_normalizado: key })
  }
  return [...byKey.values()]
}

function isTabelaAusente(error) {
  const msg = String(error?.message || error?.details || '').toLowerCase()
  if (!msg) return false
  if (msg.includes('schema cache')) return true
  return msg.includes(TABELA) && (msg.includes('does not exist') || msg.includes('not find'))
}

function uniqueIds(values) {
  const out = []
  const seen = new Set()
  for (const raw of values || []) {
    const n = Number(raw)
    if (!Number.isFinite(n) || n <= 0 || seen.has(n)) continue
    seen.add(n)
    out.push(n)
  }
  return out
}

function rowList(data) {
  if (Array.isArray(data)) return data
  if (data && typeof data === 'object' && data.id != null) return [data]
  return []
}

async function carregarVinculosPorClienteIds(supabase, companyId, clienteIds) {
  const cid = Number(companyId)
  const ids = uniqueIds(clienteIds)
  if (!Number.isFinite(cid) || cid <= 0 || ids.length === 0) return []

  const out = []
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK)
    const { data, error } = await supabase
      .from(TABELA)
      .select('id, company_id, cliente_id, nome, nome_normalizado, serie, origem')
      .eq('company_id', cid)
      .in('cliente_id', chunk)
    if (error) {
      if (isTabelaAusente(error)) return []
      throw error
    }
    for (const row of rowList(data)) {
      if (Number(row.company_id) !== cid) continue
      out.push(row)
    }
  }
  return out
}

function agruparVinculosPorCliente(vinculos) {
  const map = new Map()
  for (const row of vinculos || []) {
    const id = Number(row.cliente_id)
    if (!Number.isFinite(id) || id <= 0) continue
    if (!map.has(id)) map.set(id, [])
    map.get(id).push(row)
  }
  return map
}

function nomePrincipalDaLinha(row) {
  return (
    row?.contato_nome ||
    row?.cliente_nome ||
    row?.nome ||
    row?.nome_contato_cache ||
    ''
  )
}

function vinculosVisiveis(vinculos, nomePrincipal) {
  return (vinculos || []).filter((v) => !nomesVinculadosIguais(v.nome, nomePrincipal))
}

function resolverEncontradoPor(row, rawTerm, vinculos, mode) {
  const principal = nomePrincipalDaLinha(row)
  if (mode === 'contains') {
    if (nameMatchesUnaccentContains(principal, rawTerm)) return null
  } else if (nameMatchesWordPrefix(principal, rawTerm)) {
    return null
  }
  const hit = (vinculos || []).find((v) => vinculoCasaTermo(v, rawTerm, mode))
  return hit?.nome ? String(hit.nome).trim() : null
}

function serializarVinculo(row) {
  return {
    nome: row?.nome != null ? String(row.nome) : '',
    serie: row?.serie != null && String(row.serie).trim() ? String(row.serie).trim() : null,
  }
}

/**
 * Anexa nomes_vinculados e encontrado_por nas linhas de busca (mutates).
 * mode: 'prefix' (lista de conversas) | 'contains' (listagem de clientes).
 */
function anexarVinculosNasLinhas(rows, vinculosPorCliente, rawTerm, mode) {
  const list = Array.isArray(rows) ? rows : []
  const map = vinculosPorCliente instanceof Map ? vinculosPorCliente : agruparVinculosPorCliente(vinculosPorCliente)
  for (const row of list) {
    const clienteId = Number(row?.cliente_id ?? row?.id)
    const visiveis = vinculosVisiveis(map.get(clienteId) || [], nomePrincipalDaLinha(row))
    row.nomes_vinculados = visiveis.map(serializarVinculo)
    const encontrado = rawTerm ? resolverEncontradoPor(row, rawTerm, visiveis, mode) : null
    if (encontrado) row.encontrado_por = encontrado
    else if (row.encontrado_por != null) delete row.encontrado_por
  }
  return list
}

async function anexarVinculosEmBusca(supabase, companyId, rows, rawTerm, mode) {
  const list = Array.isArray(rows) ? rows : []
  if (list.length === 0) return list
  const ids = uniqueIds(list.map((row) => row?.cliente_id ?? row?.id))
  if (ids.length === 0) return list
  let vinculos = []
  try {
    vinculos = await carregarVinculosPorClienteIds(supabase, companyId, ids)
  } catch (err) {
    if (!isTabelaAusente(err)) console.warn('[clienteNomesVinculados] anexar busca:', err?.message || err)
    return list
  }
  return anexarVinculosNasLinhas(list, agruparVinculosPorCliente(vinculos), rawTerm, mode || 'prefix')
}

async function listarVinculosDoCliente(supabase, companyId, clienteId, nomePrincipal) {
  try {
    const rows = await carregarVinculosPorClienteIds(supabase, companyId, [clienteId])
    return vinculosVisiveis(rows, nomePrincipal).map(serializarVinculo)
  } catch (err) {
    if (!isTabelaAusente(err)) console.warn('[clienteNomesVinculados] listar:', err?.message || err)
    return []
  }
}

function filtroNomeVinculado(rawTerm, mode) {
  const termKey = normalizeNameSearchKey(rawTerm)
  if (!termKey) return null
  const escaped = escapeIlikePattern(termKey)
  if (mode === 'contains') {
    return `nome_normalizado.ilike.${quoteOrValue(`%${escaped}%`)}`
  }
  return [
    `nome_normalizado.ilike.${quoteOrValue(`${escaped}%`)}`,
    `nome_normalizado.ilike.${quoteOrValue(`% ${escaped}%`)}`,
  ].join(',')
}

async function buscarClienteIdsPorNomeVinculado(supabase, companyId, rawTerm, opts = {}) {
  const cid = Number(companyId)
  const mode = opts.mode === 'contains' ? 'contains' : 'prefix'
  const limit = Math.min(Math.max(Number(opts.limit) || 1000, 1), 3000)
  const orFilter = filtroNomeVinculado(rawTerm, mode)
  if (!Number.isFinite(cid) || cid <= 0 || !orFilter) return []

  const { data, error } = await supabase
    .from(TABELA)
    .select('cliente_id')
    .eq('company_id', cid)
    .or(orFilter)
    .limit(limit)

  if (error) {
    if (isTabelaAusente(error)) return []
    console.warn('[clienteNomesVinculados] busca ids:', error.message || error)
    return []
  }
  return uniqueIds(rowList(data).map((r) => r.cliente_id))
}

async function buscarConversaIdsPorNomesVinculados(supabase, companyId, rawTerm, limit) {
  const clienteIds = await buscarClienteIdsPorNomeVinculado(supabase, companyId, rawTerm, {
    mode: 'prefix',
    limit,
  })
  if (clienteIds.length === 0) return []
  const cap = Math.min(Math.max(Number(limit) || 1000, 1), 3000)
  const { data, error } = await supabase
    .from('conversas')
    .select('id')
    .eq('company_id', Number(companyId))
    .in('cliente_id', clienteIds)
    .limit(cap)
  if (error) {
    console.warn('[clienteNomesVinculados] conversas:', error.message || error)
    return []
  }
  return uniqueIds(rowList(data).map((r) => r.id))
}

async function upsertVinculosDoLote(supabase, companyId, itens) {
  const cid = Number(companyId)
  if (!Number.isFinite(cid) || cid <= 0) {
    throw new Error('company_id inválido')
  }

  const desired = []
  const seen = new Set()
  for (const item of Array.isArray(itens) ? itens : []) {
    const clienteId = Number(item?.clienteId)
    if (!Number.isFinite(clienteId) || clienteId <= 0) continue
    for (const aluno of alunosParaVincular(item.alunos, item.nomePrincipal)) {
      const dedupe = `${clienteId}:${aluno.nome_normalizado}`
      if (seen.has(dedupe)) {
        const prev = desired.find(
          (d) => d.cliente_id === clienteId && d.nome_normalizado === aluno.nome_normalizado
        )
        if (prev) prev.serie = aluno.serie
        continue
      }
      seen.add(dedupe)
      desired.push({
        company_id: cid,
        cliente_id: clienteId,
        nome: aluno.nome,
        nome_normalizado: aluno.nome_normalizado,
        serie: aluno.serie,
        origem: ORIGEM_PLANILHA,
      })
    }
  }

  if (desired.length === 0) {
    return { criados: 0, atualizados: 0 }
  }

  const existentes = await carregarVinculosPorClienteIds(
    supabase,
    cid,
    desired.map((d) => d.cliente_id)
  )
  const existentePorChave = new Map()
  for (const row of existentes) {
    existentePorChave.set(`${Number(row.cliente_id)}:${row.nome_normalizado}`, row)
  }

  const toInsert = []
  const toUpdate = []
  for (const row of desired) {
    const atual = existentePorChave.get(`${row.cliente_id}:${row.nome_normalizado}`)
    if (!atual) {
      toInsert.push(row)
      continue
    }
    const serieAtual = atual.serie != null ? String(atual.serie).trim() : ''
    const serieNova = row.serie != null ? String(row.serie).trim() : ''
    const nomeAtual = String(atual.nome || '').trim()
    if (serieAtual !== serieNova || nomeAtual !== row.nome) {
      toUpdate.push({ id: atual.id, cliente_id: row.cliente_id, serie: row.serie, nome: row.nome })
    }
  }

  let criados = 0
  let atualizados = 0

  for (let i = 0; i < toInsert.length; i += 100) {
    const chunk = toInsert.slice(i, i + 100)
    const { error } = await supabase.from(TABELA).insert(chunk)
    if (error) {
      if (String(error.code || '') === '23505') {
        criados += await inserirUmAUmIgnorandoDuplicata(supabase, chunk)
        continue
      }
      throw error
    }
    criados += chunk.length
  }

  for (const row of toUpdate) {
    const { error } = await supabase
      .from(TABELA)
      .update({
        nome: row.nome,
        serie: row.serie,
        atualizado_em: new Date().toISOString(),
      })
      .eq('id', row.id)
      .eq('company_id', cid)
      .eq('cliente_id', row.cliente_id)
    if (error) throw error
    atualizados++
  }

  return { criados, atualizados }
}

async function inserirUmAUmIgnorandoDuplicata(supabase, rows) {
  let criados = 0
  for (const row of rows) {
    const { error } = await supabase.from(TABELA).insert(row)
    if (!error) {
      criados++
      continue
    }
    if (String(error.code || '') === '23505') continue
    throw error
  }
  return criados
}

module.exports = {
  ORIGEM_PLANILHA,
  TABELA,
  normalizeNomeVinculado,
  nomesVinculadosIguais,
  nameMatchesUnaccentContains,
  alunosParaVincular,
  isTabelaAusente,
  uniqueIds,
  carregarVinculosPorClienteIds,
  agruparVinculosPorCliente,
  anexarVinculosNasLinhas,
  anexarVinculosEmBusca,
  listarVinculosDoCliente,
  buscarClienteIdsPorNomeVinculado,
  buscarConversaIdsPorNomesVinculados,
  upsertVinculosDoLote,
  vinculoCasaTermo,
  resolverEncontradoPor,
}
