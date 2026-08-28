/**
 * Colunas persistentes de proteção do nome (migration 20260827130000).
 * Se a migration ainda não foi aplicada, o schema PostgREST/Postgres
 * rejeita SELECT/UPDATE nesses campos. Este módulo degrada com segurança
 * para não derrubar webhook, sync nem edição manual.
 */

let schemaDisponivel = true

const CLIENTE_SELECT_BASE =
  'id, nome, pushname, foto_perfil, company_id, telefone, wa_id, email, empresa'

function schemaNomeProtecaoDisponivel() {
  return schemaDisponivel === true
}

function isErroColunaNomeProtecao(err) {
  if (!err) return false
  const code = String(err.code || '')
  const msg = String(err.message || err.details || err.hint || '')
  if (code === '42703') return true
  if (code === 'PGRST204' && /nome_(protegido|origem|override)/i.test(msg)) return true
  return /nome_protegido|nome_origem|nome_override/i.test(msg)
    && (/column/i.test(msg) || /schema cache/i.test(msg) || /could not find/i.test(msg))
}

function marcarSchemaNomeProtecaoIndisponivel(err) {
  if (!isErroColunaNomeProtecao(err)) return false
  schemaDisponivel = false
  return true
}

function resetSchemaNomeProtecaoParaTestes() {
  schemaDisponivel = true
}

function clienteSelectCols() {
  return schemaDisponivel
    ? `${CLIENTE_SELECT_BASE}, nome_origem, nome_protegido`
    : CLIENTE_SELECT_BASE
}

function sanitizarPatchNomeSchema(patch) {
  if (!patch || typeof patch !== 'object') return patch
  if (schemaDisponivel) return patch
  const next = { ...patch }
  delete next.nome_origem
  delete next.nome_protegido
  delete next.nome_override
  return next
}

async function updateClienteResiliente(supabaseClient, { id, companyId, updates }) {
  const first = sanitizarPatchNomeSchema(updates)
  let q = supabaseClient.from('clientes').update(first).eq('id', id)
  if (companyId != null) q = q.eq('company_id', companyId)
  let res = await q
  if (res.error && marcarSchemaNomeProtecaoIndisponivel(res.error)) {
    const retry = sanitizarPatchNomeSchema(updates)
    let q2 = supabaseClient.from('clientes').update(retry).eq('id', id)
    if (companyId != null) q2 = q2.eq('company_id', companyId)
    res = await q2
  }
  return res
}

async function selectClienteNomeFoto(supabaseClient, { id, companyId }) {
  const cols = schemaDisponivel
    ? 'nome, pushname, foto_perfil, nome_protegido, nome_origem'
    : 'nome, pushname, foto_perfil'
  let q = supabaseClient.from('clientes').select(cols).eq('id', id)
  if (companyId != null) q = q.eq('company_id', companyId)
  let res = await q.maybeSingle()
  if (res.error && marcarSchemaNomeProtecaoIndisponivel(res.error)) {
    let q2 = supabaseClient.from('clientes').select('nome, pushname, foto_perfil').eq('id', id)
    if (companyId != null) q2 = q2.eq('company_id', companyId)
    res = await q2.maybeSingle()
  }
  return res
}

module.exports = {
  CLIENTE_SELECT_BASE,
  schemaNomeProtecaoDisponivel,
  isErroColunaNomeProtecao,
  marcarSchemaNomeProtecaoIndisponivel,
  resetSchemaNomeProtecaoParaTestes,
  clienteSelectCols,
  sanitizarPatchNomeSchema,
  updateClienteResiliente,
  selectClienteNomeFoto,
}
