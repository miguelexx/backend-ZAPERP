/**
 * Relatório de USO de espaço no Cloudflare R2 por empresa (+ estimativa de custo).
 *
 * Lista os objetos sob media/<company_id>/ (ListObjectsV2, paginado) e soma os bytes.
 *
 * Uso (rodar NO SERVIDOR, onde o .env tem as credenciais R2):
 *   node scripts/r2-uso-empresa.js 14      -> detalhe de UMA empresa (por tipo e por mês)
 *   node scripts/r2-uso-empresa.js all     -> RANKING de todas as empresas (quem mais consome)
 *   node scripts/r2-uso-empresa.js         -> default: company_id = 1
 *
 * Só LÊ (ListObjectsV2) — não escreve, não apaga nada. Seguro rodar em produção.
 */

require('../config/env').loadEnv?.()
try { require('dotenv').config() } catch (_) {}

const crypto = require('crypto')
const { getR2Config, isR2Configured, empresaUsaR2 } = require('../config/r2')

const EMPTY_SHA256 = crypto.createHash('sha256').update('').digest('hex')

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex')
}
function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest()
}
function encodeRfc3986(str) {
  return encodeURIComponent(String(str)).replace(
    /[!*'()]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  )
}
function amzDates(date = new Date()) {
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '')
  return { amzDate, dateStamp: amzDate.slice(0, 8) }
}
function hostFromEndpoint(endpoint) {
  return new URL(endpoint).host
}

/** Assina e executa um GET ListObjectsV2 (path-style) com query string. */
async function listObjectsPage(cfg, prefix, continuationToken) {
  const host = hostFromEndpoint(cfg.endpoint)
  const { amzDate, dateStamp } = amzDates()

  const params = {
    'list-type': '2',
    'max-keys': '1000',
    prefix,
  }
  if (continuationToken) params['continuation-token'] = continuationToken

  const canonicalQuery = Object.keys(params)
    .sort()
    .map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(params[k])}`)
    .join('&')

  const canonicalUri = `/${encodeRfc3986(cfg.bucket)}/`

  const headers = {
    host,
    'x-amz-content-sha256': EMPTY_SHA256,
    'x-amz-date': amzDate,
  }
  const signedHeaders = Object.keys(headers).sort().join(';')
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((k) => `${k}:${String(headers[k]).trim()}\n`)
    .join('')

  const canonicalRequest = [
    'GET',
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    EMPTY_SHA256,
  ].join('\n')

  const scope = `${dateStamp}/${cfg.region}/${cfg.service}/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n')

  const kDate = hmac('AWS4' + cfg.secretAccessKey, dateStamp)
  const kRegion = hmac(kDate, cfg.region)
  const kService = hmac(kRegion, cfg.service)
  const kSigning = hmac(kService, 'aws4_request')
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex')

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`

  const url = `${cfg.endpoint}${canonicalUri}?${canonicalQuery}`
  const res = await fetch(url, {
    method: 'GET',
    headers: { ...headers, Authorization: authorization },
  })
  const body = await res.text()
  if (!res.ok) {
    throw new Error(`ListObjectsV2 HTTP ${res.status}: ${body.slice(0, 400)}`)
  }
  return parseListXml(body)
}

/** Parser mínimo do XML do ListObjectsV2 (sem dependência externa). */
function parseListXml(xml) {
  const objetos = []
  const re = /<Contents>([\s\S]*?)<\/Contents>/g
  let m
  while ((m = re.exec(xml))) {
    const bloco = m[1]
    const key = (bloco.match(/<Key>([\s\S]*?)<\/Key>/) || [])[1] || ''
    const size = Number((bloco.match(/<Size>(\d+)<\/Size>/) || [])[1] || 0)
    objetos.push({ key, size })
  }
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml)
  const next = (xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/) || [])[1] || null
  return { objetos, truncated, next }
}

function humano(bytes) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let n = bytes
  let i = 0
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(2)} ${u[i]}`
}

/**
 * Estimativa de custo mensal de ARMAZENAMENTO no R2 (o egress é grátis e as
 * operações costumam ficar dentro da franquia). Preço: US$0,015 por GB-mês,
 * com 10 GB grátis/mês. Câmbio ajustável via env USD_BRL (default 5.40).
 */
function custoStorageMensal(bytesTotais) {
  const PRECO_POR_GB = 0.015
  const GB_GRATIS = 10
  const gb = bytesTotais / 1024 ** 3
  const cobravel = Math.max(0, gb - GB_GRATIS)
  const usd = cobravel * PRECO_POR_GB
  const cambio = Number(process.env.USD_BRL) > 0 ? Number(process.env.USD_BRL) : 5.4
  return { gb, cobravel, usd, brl: usd * cambio, cambio }
}

/** Varre TODO um prefixo e devolve a lista completa de objetos (paginado). */
async function scanPrefixo(cfg, prefix) {
  let token = null
  const todos = []
  do {
    const { objetos, truncated, next } = await listObjectsPage(cfg, prefix, token)
    todos.push(...objetos)
    token = truncated ? next : null
  } while (token)
  return todos
}

function imprimirCusto(bytes, rotulo) {
  const c = custoStorageMensal(bytes)
  console.log(`\n===== CUSTO ESTIMADO (${rotulo}) =====`)
  console.log(`  Storage: ${c.gb.toFixed(2)} GB  (cobrável após 10 GB grátis: ${c.cobravel.toFixed(2)} GB)`)
  console.log(`  ~US$ ${c.usd.toFixed(2)}/mês   (~R$ ${c.brl.toFixed(2)}/mês @ câmbio ${c.cambio})`)
  if (rotulo !== 'BUCKET INTEIRO') {
    console.log('  Obs.: os 10 GB grátis são do bucket inteiro, não por empresa —')
    console.log('        para o custo real olhe o total do bucket (modo "all").')
  }
}

/** Modo RANKING: quem consome mais espaço. */
async function rankingTodas(cfg) {
  console.log('Varrendo TODO o bucket (media/)... isso pode levar um tempo em buckets grandes.\n')
  const objetos = await scanPrefixo(cfg, 'media/')
  const porEmpresa = {}
  let totalBytes = 0
  let totalArquivos = 0
  for (const o of objetos) {
    const partes = o.key.split('/') // [media, id, ano, mes, tipo, arquivo]
    const id = partes[1] || '?'
    porEmpresa[id] = porEmpresa[id] || { bytes: 0, arquivos: 0 }
    porEmpresa[id].bytes += o.size
    porEmpresa[id].arquivos++
    totalBytes += o.size
    totalArquivos++
  }

  console.log('===== RANKING POR EMPRESA (maior -> menor) =====')
  console.log(`  ${'company_id'.padEnd(12)} ${'espaço'.padStart(12)} ${'%'.padStart(7)}  arquivos`)
  const linhas = Object.entries(porEmpresa).sort((a, b) => b[1].bytes - a[1].bytes)
  for (const [id, v] of linhas) {
    const pct = totalBytes ? (v.bytes / totalBytes) * 100 : 0
    console.log(
      `  ${String(id).padEnd(12)} ${humano(v.bytes).padStart(12)} ${pct.toFixed(1).padStart(6)}%  ${v.arquivos}`
    )
  }

  console.log('\n===== TOTAL DO BUCKET =====')
  console.log(`  ${linhas.length} empresas · ${totalArquivos} arquivos · ${humano(totalBytes)}`)
  imprimirCusto(totalBytes, 'BUCKET INTEIRO')
}

/** Modo DETALHE: uma empresa só. */
async function detalheEmpresa(cfg, companyId) {
  console.log(`Empresa: company_id = ${companyId}`)
  console.log(`Habilitada para R2? ${empresaUsaR2(companyId) ? 'SIM' : 'NÃO (mídia provavelmente em /uploads)'}`)
  console.log(`Prefixo: media/${companyId}/`)
  console.log('Varrendo...\n')

  const objetos = await scanPrefixo(cfg, `media/${companyId}/`)
  let totalBytes = 0
  let totalArquivos = 0
  const porTipo = {}
  const porMes = {}
  for (const o of objetos) {
    totalBytes += o.size
    totalArquivos++
    const partes = o.key.split('/') // [media, id, ano, mes, tipo, arquivo]
    const ano = partes[2] || '?'
    const mes = partes[3] || '?'
    const tipo = partes[4] || '?'
    porTipo[tipo] = porTipo[tipo] || { bytes: 0, arquivos: 0 }
    porTipo[tipo].bytes += o.size
    porTipo[tipo].arquivos++
    const chaveMes = `${ano}-${mes}`
    porMes[chaveMes] = porMes[chaveMes] || { bytes: 0, arquivos: 0 }
    porMes[chaveMes].bytes += o.size
    porMes[chaveMes].arquivos++
  }

  console.log('===== POR TIPO =====')
  for (const [tipo, v] of Object.entries(porTipo).sort((a, b) => b[1].bytes - a[1].bytes)) {
    console.log(`  ${tipo.padEnd(12)} ${humano(v.bytes).padStart(12)}  (${v.arquivos} arquivos)`)
  }

  console.log('\n===== POR MÊS =====')
  for (const [mes, v] of Object.entries(porMes).sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${mes.padEnd(12)} ${humano(v.bytes).padStart(12)}  (${v.arquivos} arquivos)`)
  }

  console.log('\n===== TOTAL DA EMPRESA =====')
  console.log(`  ${totalArquivos} arquivos · ${humano(totalBytes)}  (${totalBytes.toLocaleString('pt-BR')} bytes)`)
  imprimirCusto(totalBytes, `empresa ${companyId}`)
}

async function main() {
  const arg = String(process.argv[2] || '1').toLowerCase()

  if (!isR2Configured()) {
    console.error('❌ R2 não está configurado neste .env (faltam credenciais). Rode no servidor de produção.')
    process.exit(1)
  }
  const cfg = getR2Config()
  console.log(`Bucket: ${cfg.bucket} @ ${hostFromEndpoint(cfg.endpoint)}\n`)

  if (arg === 'all' || arg === 'todas' || arg === 'ranking') {
    await rankingTodas(cfg)
  } else {
    await detalheEmpresa(cfg, Number(arg))
  }
}

main().catch((e) => {
  console.error('Erro:', e.message)
  process.exit(1)
})
