/**
 * Classifica erros Postgres/PostgREST para respostas HTTP mais úteis.
 * 42P01 (tabela ausente) e 42501 (permission denied) indicam problema de
 * infraestrutura/migration — retornar 503 com mensagem clara em vez de 500 genérico.
 */
function pgErrorStatus(error) {
  const code = String(error?.code || '')
  const msg = String(error?.message || '').toLowerCase()
  if (code === '42P01' || msg.includes('does not exist')) {
    return { status: 503, message: 'Tabela não encontrada — migration pendente no banco' }
  }
  if (code === '42501' || msg.includes('permission denied')) {
    return { status: 503, message: 'Permissão negada no banco — verificar configuração' }
  }
  return { status: 500, message: null }
}

module.exports = { pgErrorStatus }
