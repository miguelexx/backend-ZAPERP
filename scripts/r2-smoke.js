/**
 * Teste de fumaça do Cloudflare R2 — valida credenciais + assinatura SigV4 de ponta a ponta,
 * SEM depender do fluxo de mensagens. Usa as variáveis do .env.
 *
 * Uso:
 *   node scripts/r2-smoke.js
 *
 * O que faz:
 *   1) Mostra a config detectada (sem vazar o secret).
 *   2) PUT de um objeto de teste (media/<company>/_smoke/<timestamp>.txt).
 *   3) HEAD para confirmar tamanho.
 *   4) Gera presigned URL e faz GET, conferindo o conteúdo.
 *   5) DELETE do objeto de teste.
 *
 * Qualquer erro aqui explica por que a mídia não aparece no R2 (credencial errada,
 * bucket errado, permissão do token, endpoint, relógio do servidor, etc.).
 */

require('../config/env').loadEnv?.()
try { require('dotenv').config() } catch (_) {}

const { getR2Config, isR2Configured, getR2CompanyIds } = require('../config/r2')
const r2 = require('../services/storage/r2Client')

function mask(v) {
  const s = String(v || '')
  if (!s) return '(vazio)'
  if (s.length <= 6) return '***'
  return `${s.slice(0, 3)}***${s.slice(-3)}`
}

async function main() {
  const cfg = getR2Config()
  console.log('=== Config R2 detectada ===')
  console.log('  endpoint          :', cfg.endpoint || '(vazio)')
  console.log('  bucket            :', cfg.bucket || '(vazio)')
  console.log('  accessKeyId       :', mask(cfg.accessKeyId))
  console.log('  secretAccessKey   :', cfg.secretAccessKey ? '(presente)' : '(VAZIO!)')
  console.log('  region/service    :', cfg.region, '/', cfg.service)
  console.log('  company habilitadas:', [...getR2CompanyIds()].join(', '))
  console.log('  isR2Configured    :', isR2Configured())
  console.log('')

  if (!isR2Configured()) {
    console.error('❌ R2 NÃO está configurado. Preencha R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY e R2_BUCKET no .env.')
    process.exit(1)
  }

  const key = `media/1/_smoke/${Date.now()}.txt`
  const payload = Buffer.from(`smoke-test ${new Date().toISOString()}`)

  try {
    console.log('→ PUT', key, `(${payload.length} bytes)`)
    await r2.putObject(key, payload, 'text/plain')
    console.log('  ✅ PUT ok')

    console.log('→ HEAD', key)
    const head = await r2.headObject(key)
    console.log('  ✅ HEAD ok:', head)
    if (head.size !== payload.length) console.warn('  ⚠️ tamanho divergente!')

    console.log('→ PRESIGN + GET')
    const url = r2.presignGetUrl(key, 120)
    const res = await fetch(url)
    const body = await res.text()
    console.log('  status GET presigned:', res.status)
    if (res.ok && body === payload.toString()) console.log('  ✅ conteúdo confere')
    else console.warn('  ⚠️ conteúdo NÃO confere:', body.slice(0, 80))

    console.log('→ DELETE', key)
    await r2.deleteObject(key)
    console.log('  ✅ DELETE ok')

    console.log('\n🎉 R2 está funcionando. Se a mídia não aparece, o problema é no fluxo/timing, não na conexão.')
  } catch (e) {
    console.error('\n❌ Falhou:', e?.message || e)
    console.error('   Dica: HTTP 403/SignatureDoesNotMatch = credencial/secret errado ou relógio do servidor fora de hora.')
    console.error('         HTTP 404 NoSuchBucket = R2_BUCKET errado. HTTP 401 = token sem permissão no bucket.')
    process.exit(1)
  }
}

main()
