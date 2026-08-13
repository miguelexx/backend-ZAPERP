const assert = require('node:assert/strict')

/** Recarrega o módulo config/r2 sob um conjunto de env vars controladas. */
function loadR2Config(env) {
  const OLD = { ...process.env }
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('R2_')) delete process.env[k]
  }
  Object.assign(process.env, env)
  delete require.cache[require.resolve('../config/r2')]
  const mod = require('../config/r2')
  // restaura o process.env depois de ler (o módulo já capturou via getters em runtime)
  return { mod, restore: () => { process.env = OLD } }
}

const CREDS_OK = {
  R2_ACCOUNT_ID: 'acc123',
  R2_ACCESS_KEY_ID: 'AKIAEXAMPLE',
  R2_SECRET_ACCESS_KEY: 'secretexample',
  R2_BUCKET: 'zaperp-media-test',
}

test('empresaUsaR2: só company 1 por padrão quando R2 configurado', () => {
  const { mod, restore } = loadR2Config(CREDS_OK)
  try {
    assert.equal(mod.isR2Configured(), true)
    assert.equal(mod.empresaUsaR2(1), true)
    assert.equal(mod.empresaUsaR2(2), false)
    assert.equal(mod.empresaUsaR2(99), false)
  } finally { restore() }
})

test('empresaUsaR2: false para todas quando R2 NÃO configurado (fluxo antigo)', () => {
  const { mod, restore } = loadR2Config({ R2_BUCKET: '', R2_ACCESS_KEY_ID: '' })
  try {
    assert.equal(mod.isR2Configured(), false)
    assert.equal(mod.empresaUsaR2(1), false)
    assert.equal(mod.empresaUsaR2(2), false)
  } finally { restore() }
})

test('empresaUsaR2: respeita R2_COMPANY_IDS (CSV)', () => {
  const { mod, restore } = loadR2Config({ ...CREDS_OK, R2_COMPANY_IDS: '1,7' })
  try {
    assert.equal(mod.empresaUsaR2(1), true)
    assert.equal(mod.empresaUsaR2(7), true)
    assert.equal(mod.empresaUsaR2(3), false)
  } finally { restore() }
})

test('empresaUsaR2: entradas inválidas', () => {
  const { mod, restore } = loadR2Config(CREDS_OK)
  try {
    assert.equal(mod.empresaUsaR2(0), false)
    assert.equal(mod.empresaUsaR2(-1), false)
    assert.equal(mod.empresaUsaR2(null), false)
    assert.equal(mod.empresaUsaR2('abc'), false)
  } finally { restore() }
})

test('endpoint derivado do account id; presign clamp em 7 dias', () => {
  const { mod, restore } = loadR2Config({ ...CREDS_OK, R2_PRESIGN_EXPIRES_SECONDS: '9999999' })
  try {
    assert.equal(mod.getR2Config().endpoint, 'https://acc123.r2.cloudflarestorage.com')
    assert.equal(mod.getPresignExpiresSeconds(), 604800)
  } finally { restore() }
})
