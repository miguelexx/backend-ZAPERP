/**
 * Persistência da trava atendente ↔ número WhatsApp.
 * Leitura com falha (tabela ainda não migrada, erro transitório) não restringe ninguém:
 * o atendimento continua como está. Gravar sem a tabela devolve erro explícito.
 */

const supabase = require('../../../config/supabase')
const { atendentePodeVerNumero } = require('./usuarioWhatsappInstanceAccessRules')

const CACHE_MS = 15_000
const MISSING_CACHE_MS = 60_000
const cache = new Map()
let missingLogged = false
let readFailedLogged = false

class AcessoNumerosIndisponivel extends Error {
  constructor(message) {
    super(message || 'A configuração de números ainda não está no banco. Aplique a migration usuario_whatsapp_instances.')
    this.name = 'AcessoNumerosIndisponivel'
    this.statusCode = 503
  }
}

function isMissingTable(error) {
  const code = String(error?.code || '')
  const msg = String(error?.message || error || '').toLowerCase()
  return (
    code === '42P01' ||
    code === 'PGRST205' ||
    code === '42501' ||
    (msg.includes('usuario_whatsapp_instances') &&
      (msg.includes('does not exist') ||
        msg.includes('could not find') ||
        msg.includes('schema cache') ||
        msg.includes('permission denied')))
  )
}

function mapaDoCache(company_id) {
  const hit = cache.get(Number(company_id))
  if (!hit || hit.expires <= Date.now()) return null
  return hit.mapa
}

function guardarMapa(company_id, mapa, ttl) {
  cache.set(Number(company_id), { mapa, expires: Date.now() + ttl })
}

function invalidateAcessoNumerosCache(company_id) {
  if (company_id == null) {
    cache.clear()
    return
  }
  cache.delete(Number(company_id))
}

function montarMapa(rows) {
  const mapa = new Map()
  for (const row of rows || []) {
    const uid = Number(row.usuario_id)
    const iid = Number(row.whatsapp_instance_id)
    if (!Number.isInteger(uid) || uid <= 0 || !Number.isInteger(iid) || iid <= 0) continue
    if (!mapa.has(uid)) mapa.set(uid, new Set())
    mapa.get(uid).add(iid)
  }
  return mapa
}

/**
 * Map usuario_id → Set de whatsapp_instance_id.
 * Usuário ausente do mapa não tem trava.
 * Falha de leitura devolve mapa vazio (não esconde conversa por engano).
 */
async function carregarMapaAcessoNumeros(company_id) {
  const cid = Number(company_id)
  if (!Number.isInteger(cid) || cid <= 0) return new Map()
  const cached = mapaDoCache(cid)
  if (cached) return cached

  let data
  let error
  try {
    const res = await supabase
      .from('usuario_whatsapp_instances')
      .select('usuario_id, whatsapp_instance_id')
      .eq('company_id', cid)
    data = res?.data
    error = res?.error
  } catch (err) {
    if (!readFailedLogged) {
      readFailedLogged = true
      console.warn('[acesso-numeros] leitura falhou; visão segue sem trava.', err?.message || err)
    }
    return new Map()
  }

  if (error) {
    if (isMissingTable(error)) {
      if (!missingLogged) {
        missingLogged = true
        console.warn('[acesso-numeros] tabela usuario_whatsapp_instances indisponível; visão segue sem trava.')
      }
      const vazio = new Map()
      guardarMapa(cid, vazio, MISSING_CACHE_MS)
      return vazio
    }
    console.warn('[acesso-numeros] leitura:', error.message || error)
    return new Map()
  }

  const mapa = montarMapa(data)
  guardarMapa(cid, mapa, CACHE_MS)
  return mapa
}

/** null = sem trava. Set = só esses números. */
async function instanciasPermitidasDoUsuario(company_id, usuario_id) {
  const mapa = await carregarMapaAcessoNumeros(company_id)
  const set = mapa.get(Number(usuario_id))
  if (!set || set.size === 0) return null
  return set
}

async function listarVinculos(company_id) {
  const cid = Number(company_id)
  const { data, error } = await supabase
    .from('usuario_whatsapp_instances')
    .select('usuario_id, whatsapp_instance_id')
    .eq('company_id', cid)
  if (error) {
    if (isMissingTable(error)) throw new AcessoNumerosIndisponivel()
    throw error
  }
  return data || []
}

async function substituirAtendentesDoNumero({ company_id, whatsapp_instance_id, usuario_ids }) {
  const cid = Number(company_id)
  const iid = Number(whatsapp_instance_id)
  if (!Number.isInteger(cid) || cid <= 0 || !Number.isInteger(iid) || iid <= 0) {
    const err = new Error('Número inválido')
    err.statusCode = 400
    throw err
  }

  const { data: inst, error: instErr } = await supabase
    .from('whatsapp_instances')
    .select('id')
    .eq('company_id', cid)
    .eq('id', iid)
    .maybeSingle()
  if (instErr) throw instErr
  if (!inst) {
    const err = new Error('Número não encontrado nesta empresa')
    err.statusCode = 404
    throw err
  }

  const ids = [...new Set((usuario_ids || []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))]
  if (ids.length > 200) {
    const err = new Error('Selecione no máximo 200 atendentes por número')
    err.statusCode = 400
    throw err
  }

  if (ids.length > 0) {
    const { data: users, error: userErr } = await supabase
      .from('usuarios')
      .select('id, perfil, ativo')
      .eq('company_id', cid)
      .in('id', ids)
    if (userErr) throw userErr
    const ok = new Set(
      (users || [])
        .filter((u) => u.ativo !== false && String(u.perfil || '').toLowerCase() === 'atendente')
        .map((u) => Number(u.id))
    )
    const invalidos = ids.filter((id) => !ok.has(id))
    if (invalidos.length > 0) {
      const err = new Error('Só atendentes ativos entram nesta trava. Admin e supervisor já veem todos os números.')
      err.statusCode = 400
      throw err
    }
  }

  const { data: atuais, error: atuaisErr } = await supabase
    .from('usuario_whatsapp_instances')
    .select('usuario_id')
    .eq('company_id', cid)
    .eq('whatsapp_instance_id', iid)
  if (atuaisErr) {
    if (isMissingTable(atuaisErr)) throw new AcessoNumerosIndisponivel()
    throw atuaisErr
  }

  const anteriores = (atuais || []).map((row) => Number(row.usuario_id)).filter((id) => Number.isInteger(id) && id > 0)
  const novos = new Set(ids)
  const anterioresSet = new Set(anteriores)
  const incluir = ids.filter((id) => !anterioresSet.has(id))
  const remover = anteriores.filter((id) => !novos.has(id))

  if (incluir.length > 0) {
    const { error: insErr } = await supabase.from('usuario_whatsapp_instances').insert(
      incluir.map((usuario_id) => ({
        company_id: cid,
        usuario_id,
        whatsapp_instance_id: iid,
      }))
    )
    if (insErr) {
      if (isMissingTable(insErr)) throw new AcessoNumerosIndisponivel()
      throw insErr
    }
  }

  if (remover.length > 0) {
    const { error: delErr } = await supabase
      .from('usuario_whatsapp_instances')
      .delete()
      .eq('company_id', cid)
      .eq('whatsapp_instance_id', iid)
      .in('usuario_id', remover)
    if (delErr) {
      if (isMissingTable(delErr)) throw new AcessoNumerosIndisponivel()
      throw delErr
    }
  }

  invalidateAcessoNumerosCache(cid)
  return {
    atendente_ids: ids,
    afetados: [...new Set([...anteriores, ...ids])],
  }
}

module.exports = {
  AcessoNumerosIndisponivel,
  atendentePodeVerNumero,
  carregarMapaAcessoNumeros,
  instanciasPermitidasDoUsuario,
  listarVinculos,
  substituirAtendentesDoNumero,
  invalidateAcessoNumerosCache,
}
