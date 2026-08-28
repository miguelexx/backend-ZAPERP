/**
 * Execução da importação de clientes por planilha.
 *
 * Reutiliza getOrCreateCliente() (dedup por telefone + company_id, sem criar conversa)
 * e aplica o nome da planilha com proteção persistente (nome_origem=import_planilha,
 * nome_protegido=true). Tags usam UNIQUE da empresa; vínculos não duplicam.
 */

const { getOrCreateCliente } = require('../helpers/conversationSync')
const { possiblePhonesBR, phoneKeyBR } = require('../helpers/phoneHelper')
const {
  ORIGEM_IMPORT_PLANILHA,
  ORIGEM_MANUAL,
  clienteTemNomeProtegido,
} = require('../helpers/clienteNomeProtecao')

async function getOrCreateTag(supabase, companyId, nomeTag, cache) {
  const nome = String(nomeTag || '').replace(/\s+/g, ' ').trim()
  if (!nome) return { id: null, criada: false }

  const cacheKey = nome.toLowerCase()
  if (cache.has(cacheKey)) return { id: cache.get(cacheKey), criada: false }

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

  const { data: nova, error } = await supabase
    .from('tags')
    .insert({ nome, cor: null, company_id: companyId })
    .select('id')
    .single()

  if (!error && nova?.id) {
    cache.set(cacheKey, nova.id)
    return { id: nova.id, criada: true }
  }

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

  for (const tagId of alvo) {
    if (atuais.has(tagId)) continue
    if (await linkClienteTag(supabase, companyId, clienteId, tagId)) vinculadas++
  }

  return { vinculadas, removidas }
}

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
    if (String(error.code || '') === '23505') return false
    throw error
  }
  return true
}

function nomesIguais(a, b) {
  return String(a || '').replace(/\s+/g, ' ').trim().toLowerCase() ===
    String(b || '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function rowList(data) {
  if (Array.isArray(data)) return data
  if (data && typeof data === 'object' && data.id != null) return [data]
  return []
}

async function buscarClientesExistentesDoPlano(supabase, companyId, entries) {
  const cid = Number(companyId)
  const phones = new Set()
  for (const entry of entries || []) {
    const tel = entry.telefoneNormalizado || entry.telefone
    if (!tel) continue
    phones.add(String(tel))
    for (const v of possiblePhonesBR(tel)) phones.add(String(v))
  }
  const list = [...phones]
  const byKey = new Map()
  const SELECT_COLS = 'id, telefone, nome, nome_origem, nome_protegido, foto_perfil'

  for (let i = 0; i < list.length; i += 200) {
    const chunk = list.slice(i, i + 200)
    let data = null
    let error = null
    try {
      const res = await supabase
        .from('clientes')
        .select(SELECT_COLS)
        .eq('company_id', cid)
        .in('telefone', chunk)
      data = res?.data
      error = res?.error
    } catch (e) {
      error = e
    }
    if (error) {
      try {
        const res = await supabase
          .from('clientes')
          .select('id, telefone, nome, foto_perfil')
          .eq('company_id', cid)
          .in('telefone', chunk)
        data = res?.data
      } catch (_) {
        data = null
      }
    }
    for (const row of rowList(data)) {
      const key = phoneKeyBR(row.telefone) || String(row.telefone || '')
      if (!key) continue
      const prev = byKey.get(key)
      if (!prev || Number(row.id) < Number(prev.id)) byKey.set(key, row)
    }
  }

  return byKey
}

function classificarExistente(entry, existente) {
  if (!existente) {
    return { tipo: 'novo', nomeAtual: null }
  }
  const nomeAtual = existente.nome != null ? String(existente.nome).trim() : ''
  const protegido = clienteTemNomeProtegido(existente)
  const origem = String(existente.nome_origem || '')
  if (nomeAtual && nomesIguais(nomeAtual, entry.nome)) {
    return { tipo: 'igual', nomeAtual, protegido, origem }
  }
  if (protegido && origem === ORIGEM_MANUAL) {
    return { tipo: 'manual_protegido', nomeAtual, protegido, origem }
  }
  return { tipo: 'alterar', nomeAtual, protegido, origem }
}

async function enriquecerPlanoComExistentes(supabase, companyId, plano) {
  const entries = Array.isArray(plano?.entries) ? plano.entries : []
  const existentes = await buscarClientesExistentesDoPlano(supabase, companyId, entries)
  const nomeSeraAlterado = []
  const nomesManuaisProtegidos = []
  const jaExistentesIguais = []

  for (const entry of entries) {
    const key = entry.phoneKey || phoneKeyBR(entry.telefoneNormalizado || entry.telefone)
    const row = key ? existentes.get(key) : null
    const cls = classificarExistente(entry, row)
    entry.existente = row
      ? {
          id: row.id,
          nome: row.nome,
          nome_origem: row.nome_origem || null,
          nome_protegido: clienteTemNomeProtegido(row),
          classificacao: cls.tipo,
        }
      : null
    const item = {
      telefone: entry.telefoneNormalizado,
      nome_planilha: entry.nome,
      nome_atual: cls.nomeAtual,
      tags: entry.tags,
      cliente_id: row?.id || null,
    }
    if (cls.tipo === 'alterar') nomeSeraAlterado.push(item)
    else if (cls.tipo === 'manual_protegido') nomesManuaisProtegidos.push(item)
    else if (cls.tipo === 'igual') jaExistentesIguais.push(item)
  }

  return {
    ...plano,
    existentesPorTelefone: existentes,
    nomeSeraAlterado,
    nomesManuaisProtegidos,
    jaExistentesIguais,
  }
}

async function espelharNomeNaConversa(supabase, companyId, clienteId, nome) {
  if (!clienteId || !nome) return
  try {
    await supabase
      .from('conversas')
      .update({ nome_contato_cache: nome })
      .eq('company_id', companyId)
      .eq('cliente_id', clienteId)
  } catch (_) {
    /* conversa pode não existir; a proteção do nome está em clientes */
  }
}

async function executarImportacao(supabase, companyId, plano, opts = {}) {
  const cid = Number(companyId)
  if (!Number.isFinite(cid) || cid <= 0) {
    throw new Error('company_id inválido')
  }

  const entries = Array.isArray(plano?.entries) ? plano.entries : []
  const confirmarNomeManual = opts.confirmarNomeManual === true
  const tagCache = new Map()

  let clientesCriados = 0
  let clientesAtualizados = 0
  let clientesJaExistentes = 0
  let nomesAlterados = 0
  let nomesProtegidos = 0
  let nomesManuaisPreservados = 0
  let tagsVinculadas = 0
  let tagsCriadas = 0
  let tagsRemovidas = 0
  const falhas = []

  let existentesMap = new Map()
  try {
    existentesMap = plano?.existentesPorTelefone instanceof Map
      ? plano.existentesPorTelefone
      : await buscarClientesExistentesDoPlano(supabase, cid, entries)
  } catch (_) {
    existentesMap = new Map()
  }

  for (const entry of entries) {
    try {
      const key = entry.phoneKey || phoneKeyBR(entry.telefone)
      const existente = key ? existentesMap.get(key) : null
      const cls = classificarExistente(entry, existente)
      const preservarManual = cls.tipo === 'manual_protegido' && !confirmarNomeManual

      const fields = {
        nomeSource: ORIGEM_IMPORT_PLANILHA,
        confirmarNomeManual,
      }
      if (!preservarManual) {
        fields.nome = entry.nome
      }

      const criado = await getOrCreateCliente(supabase, cid, entry.telefone, fields)

      if (!criado?.cliente_id) {
        falhas.push({
          telefone: entry.telefone,
          nome: entry.nome,
          motivo: 'Não foi possível cadastrar/localizar o cliente',
        })
        continue
      }

      const clienteId = criado.cliente_id

      if (criado.created === true) {
        clientesCriados++
        nomesProtegidos++
      } else {
        clientesJaExistentes++
        if (preservarManual) {
          nomesManuaisPreservados++
        } else if (cls.tipo === 'alterar' || (criado.changed && !nomesIguais(cls.nomeAtual, entry.nome))) {
          clientesAtualizados++
          if (!nomesIguais(cls.nomeAtual, entry.nome)) nomesAlterados++
        }
        if (criado.nome_protegido || !preservarManual) nomesProtegidos++
      }

      if (!preservarManual) {
        await espelharNomeNaConversa(supabase, cid, clienteId, entry.nome)
      }

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
      clientesCriados,
      clientesImportados: clientesCriados,
      clientesAtualizados,
      clientesJaExistentes,
      nomesAlterados,
      nomesProtegidos,
      nomesManuaisPreservados,
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
  buscarClientesExistentesDoPlano,
  enriquecerPlanoComExistentes,
  classificarExistente,
  ORIGEM_IMPORT_PLANILHA,
  ORIGEM_MANUAL,
}
