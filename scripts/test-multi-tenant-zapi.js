/**
 * Teste multi-tenant Z-API
 *
 * Pré-requisitos:
 * - Duas empresas (company_id A e B) com registros em empresa_zapi
 * - Dois JWTs (usuário da empresa A e da empresa B)
 *
 * Uso:
 *   TOKEN_A="jwt_empresa_a" TOKEN_B="jwt_empresa_b" node scripts/test-multi-tenant-zapi.js
 *
 * Ou com login:
 *   LOGIN_A="user_a@empresa.com" SENHA_A="..." LOGIN_B="user_b@empresa.com" SENHA_B="..." node scripts/test-multi-tenant-zapi.js
 */

const API_BASE = process.env.API_BASE || 'http://localhost:3000/api'

async function main() {
  let tokenA = process.env.TOKEN_A
  let tokenB = process.env.TOKEN_B

  if (!tokenA && process.env.LOGIN_A && process.env.SENHA_A) {
    const r = await fetch(`${API_BASE}/usuarios/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: process.env.LOGIN_A, senha: process.env.SENHA_A })
    })
    const j = await r.json()
    tokenA = j?.token
    if (!tokenA) {
      console.error('Login A falhou:', j)
      process.exit(1)
    }
  }
  if (!tokenB && process.env.LOGIN_B && process.env.SENHA_B) {
    const r = await fetch(`${API_BASE}/usuarios/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: process.env.LOGIN_B, senha: process.env.SENHA_B })
    })
    const j = await r.json()
    tokenB = j?.token
    if (!tokenB) {
      console.error('Login B falhou:', j)
      process.exit(1)
    }
  }

  if (!tokenA || !tokenB) {
    console.error('Defina TOKEN_A e TOKEN_B (ou LOGIN_A/SENHA_A e LOGIN_B/SENHA_B)')
    process.exit(1)
  }

  const headersA = { Authorization: `Bearer ${tokenA}` }
  const headersB = { Authorization: `Bearer ${tokenB}` }

  console.log('\n1) GET /integrations/zapi/connect/status (empresa A)')
  const resA = await fetch(`${API_BASE}/integrations/zapi/connect/status`, { headers: headersA })
  const dataA = await resA.json()
  console.log('   Status A:', dataA?.hasInstance ? 'hasInstance' : 'sem instância', dataA?.connected ? 'conectado' : '')
  if (dataA?.meSummary?.id) console.log('   instanceId (meSummary):', String(dataA.meSummary.id).slice(0, 16) + '…')

  console.log('\n2) GET /integrations/zapi/connect/status (empresa B)')
  const resB = await fetch(`${API_BASE}/integrations/zapi/connect/status`, { headers: headersB })
  const dataB = await resB.json()
  console.log('   Status B:', dataB?.hasInstance ? 'hasInstance' : 'sem instância', dataB?.connected ? 'conectado' : '')
  if (dataB?.meSummary?.id) console.log('   instanceId (meSummary):', String(dataB.meSummary.id).slice(0, 16) + '…')

  const idA = dataA?.meSummary?.id
  const idB = dataB?.meSummary?.id
  if (idA && idB && String(idA) !== String(idB)) {
    console.log('\n✅ OK: Empresas A e B retornam instâncias DIFERENTES (multi-tenant funcionando)')
  } else if (idA || idB) {
    console.log('\n⚠️ Instâncias iguais ou uma sem meSummary. Verifique empresa_zapi para cada company_id.')
  } else {
    console.log('\n⚠️ Ambas sem instância. Configure empresa_zapi para ambas as empresas.')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
