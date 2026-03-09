/**
 * Serviço de permissões: verifica se usuário possui permissão
 * Considera: 1) override em usuario_permissoes, 2) padrão do perfil
 */
const supabase = require('../config/supabase')
const { perfilTemPermissaoPorPadrao, PERMISSOES_POR_CODIGO } = require('./permissoesCatalogo')

/** Cache em memória por request (evitar múltiplas queries) */
const cacheKey = (userId, companyId) => `${companyId}_${userId}`

/**
 * Verifica se o usuário tem a permissão.
 * @param {object} opts - { usuario_id, company_id, perfil, permissao_codigo }
 * @param {object} [opts.overrideCache] - mapa { codigo: boolean } já carregado
 * @returns {Promise<boolean>}
 */
async function usuarioTemPermissao({ usuario_id, company_id, perfil, permissao_codigo }, overrideCache = null) {
  if (!permissao_codigo) return false
  const codigo = String(permissao_codigo).trim()
  if (perfil === 'admin') return true // admin sempre tem tudo

  // 1) Verificar override explícito em usuario_permissoes
  let overrides = overrideCache
  if (!overrides) {
    overrides = await carregarPermissoesUsuario(usuario_id, company_id)
  }
  if (overrides && typeof overrides[codigo] === 'boolean') {
    return overrides[codigo]
  }

  // 2) Fallback: padrão do perfil
  return perfilTemPermissaoPorPadrao(perfil, codigo)
}

/**
 * Carrega mapa de overrides: { codigo: boolean }
 */
async function carregarPermissoesUsuario(usuario_id, company_id) {
  const { data, error } = await supabase
    .from('usuario_permissoes')
    .select('permissao_codigo, concedido')
    .eq('usuario_id', Number(usuario_id))
    .eq('company_id', Number(company_id))

  if (error || !Array.isArray(data)) return {}
  const map = {}
  for (const row of data) {
    const cod = String(row.permissao_codigo || '').trim()
    if (cod) map[cod] = !!row.concedido
  }
  return map
}

/**
 * Retorna todas as permissões do usuário (efetivas: override + padrão do perfil)
 * @returns {Promise<Array<{codigo, nome, descricao, categoria, concedido, isOverride}>>}
 */
async function getPermissoesEfetivasUsuario(usuario_id, company_id, perfil) {
  const { PERMISSOES_CATALOGO } = require('./permissoesCatalogo')
  const overrides = await carregarPermissoesUsuario(usuario_id, company_id)

  const result = []
  for (const p of PERMISSOES_CATALOGO) {
    let concedido
    let isOverride = false
    if (typeof overrides[p.codigo] === 'boolean') {
      concedido = overrides[p.codigo]
      isOverride = true
    } else {
      concedido = perfil === 'admin' || perfilTemPermissaoPorPadrao(perfil, p.codigo)
    }
    result.push({
      ...p,
      concedido,
      isOverride
    })
  }
  return result
}

/**
 * Atualiza permissões de um usuário (apenas overrides; null = usar padrão do perfil)
 * @param {number} usuario_id
 * @param {number} company_id
 * @param {object} permissoes - { codigo: boolean | null } - null remove o override
 */
async function salvarPermissoesUsuario(usuario_id, company_id, permissoes) {
  const uid = Number(usuario_id)
  const cid = Number(company_id)
  if (!uid || !cid) return { error: 'usuario_id e company_id são obrigatórios' }

  for (const [codigo, valor] of Object.entries(permissoes || {})) {
    const cod = String(codigo || '').trim()
    if (!cod || !PERMISSOES_POR_CODIGO[cod]) continue

    if (valor === null || valor === undefined) {
      await supabase
        .from('usuario_permissoes')
        .delete()
        .eq('usuario_id', uid)
        .eq('company_id', cid)
        .eq('permissao_codigo', cod)
    } else {
      const { error } = await supabase
        .from('usuario_permissoes')
        .upsert(
          { usuario_id: uid, company_id: cid, permissao_codigo: cod, concedido: !!valor },
          { onConflict: 'usuario_id,permissao_codigo', ignoreDuplicates: false }
        )
      if (error) return { error: error.message }
    }
  }
  return {}
}

module.exports = {
  usuarioTemPermissao,
  carregarPermissoesUsuario,
  getPermissoesEfetivasUsuario,
  salvarPermissoesUsuario
}
