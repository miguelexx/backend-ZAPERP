/**
 * Script para testar o envio de arquivo/áudio para POST /chats/:id/arquivo
 *
 * Uso:
 *   node scripts/test-envio-audio.js
 *
 * Requer: .env com JWT válido (ou passe TOKEN e CONVERSA_ID e BASE_URL)
 *
 * Exemplo:
 *   TOKEN=eyJ... CONVERSA_ID=468 BASE_URL=http://localhost:3000 node scripts/test-envio-audio.js
 */

const fs = require('fs')
const path = require('path')
const https = require('https')
const http = require('http')

require('dotenv').config({ path: path.join(__dirname, '../.env') })

const TOKEN = process.env.TOKEN
const CONVERSA_ID = process.env.CONVERSA_ID || '468'
const BASE_URL = process.env.BASE_URL || process.env.APP_URL || 'http://localhost:3000'

// Cria um arquivo de áudio mínimo (1 segundo de silêncio em formato válido)
// Formato: arquivo raw PCM ou um webm mínimo
function criarAudioTeste() {
  const uploadDir = path.join(__dirname, '../uploads')
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true })
  const filePath = path.join(uploadDir, `test-audio-${Date.now()}.webm`)
  // WebM mínimo com áudio - header simples
  const webmHeader = Buffer.from([
    0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01,
    0x42, 0xf7, 0x81, 0x01, 0x42, 0xf2, 0x81, 0x04, 0x42, 0xf3, 0x81, 0x08,
    0x42, 0x82, 0x88, 0x77, 0x65, 0x62, 0x6d, 0x42, 0x87, 0x81, 0x02,
    0x42, 0x85, 0x81, 0x02
  ])
  fs.writeFileSync(filePath, webmHeader)
  return filePath
}

// Alternativa: usar um arquivo existente se houver
function encontrarArquivoTeste() {
  const uploadDir = path.join(__dirname, '../uploads')
  if (fs.existsSync(uploadDir)) {
    const files = fs.readdirSync(uploadDir)
    const audio = files.find(f => /\.(webm|ogg|mp3|m4a|wav)$/i.test(f))
    if (audio) return path.join(uploadDir, audio)
  }
  return criarAudioTeste()
}

async function testarEnvio() {
  const url = new URL(`${BASE_URL.replace(/\/$/, '')}/chats/${CONVERSA_ID}/arquivo`)
  const filePath = encontrarArquivoTeste()
  const fileContent = fs.readFileSync(filePath)
  const fileName = path.basename(filePath)

  const boundary = `----WebKitFormBoundary${Date.now()}`
  const bodyParts = [
    `--${boundary}\r\n`,
    `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n`,
    `Content-Type: audio/webm\r\n\r\n`,
    fileContent,
    `\r\n--${boundary}--\r\n`
  ]
  const body = Buffer.concat(bodyParts.map(p => Buffer.isBuffer(p) ? p : Buffer.from(p, 'utf8')))

  const options = {
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname,
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length
    }
  }

  const httpModule = url.protocol === 'https:' ? https : http

  return new Promise((resolve, reject) => {
    const req = httpModule.request(options, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try {
          const json = data ? JSON.parse(data) : {}
          resolve({ status: res.statusCode, data: json })
        } catch {
          resolve({ status: res.statusCode, data: { raw: data } })
        }
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

async function main() {
  console.log('=== Teste de envio de áudio ===')
  console.log('Base URL:', BASE_URL)
  console.log('Conversa ID:', CONVERSA_ID)
  console.log('Token:', TOKEN ? `${TOKEN.slice(0, 20)}...` : '(não definido)')

  if (!TOKEN || TOKEN.length < 50) {
    console.error('\nErro: Defina TOKEN no .env ou variável de ambiente com um JWT válido.')
    console.error('Ex: faça login no sistema e copie o token do localStorage.')
    process.exit(1)
  }

  const { status, data } = await testarEnvio()
  console.log('\nResposta:', status, data)

  if (status === 200 && data.ok) {
    console.log('\n✅ Sucesso! Arquivo enviado. id:', data.id, 'conversa_id:', data.conversa_id)
  } else {
    console.error('\n❌ Falha. Erro:', data.error || data)
    process.exit(1)
  }
}

main().catch(err => {
  console.error('Erro:', err.message)
  process.exit(1)
})
