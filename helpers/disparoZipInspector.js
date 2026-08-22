/**
 * Inspeção segura da estrutura interna de arquivos ZIP (Office Open XML).
 * Lê apenas o central directory — não descompacta conteúdo (proteção contra ZIP bomb).
 */

const fs = require('fs')

const MAX_ENTRIES = 5000
const MAX_UNCOMPRESSED_DECLARED = 500 * 1024 * 1024 // 500 MB declarado total
const MAX_SINGLE_ENTRY_DECLARED = 200 * 1024 * 1024

/**
 * Lê nomes de entradas do ZIP a partir do central directory (EOCD).
 * @param {string|Buffer} source - caminho do arquivo ou buffer
 * @returns {{ names: string[], entryCount: number, totalUncompressed: number }}
 */
function listarEntradasZip(source) {
  const buf = Buffer.isBuffer(source) ? source : fs.readFileSync(source)
  if (buf.length < 22) {
    throw Object.assign(new Error('Arquivo ZIP inválido ou truncado.'), {
      status: 400,
      code: 'DISPARO_ZIP_INVALIDO',
    })
  }

  // Localiza End of Central Directory (assinatura PK\\x05\\x06)
  let eocdOffset = -1
  const maxScan = Math.min(buf.length, 65557)
  for (let i = buf.length - 22; i >= buf.length - maxScan; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) {
      eocdOffset = i
      break
    }
  }
  if (eocdOffset < 0) {
    throw Object.assign(new Error('Estrutura ZIP inválida (EOCD não encontrado).'), {
      status: 400,
      code: 'DISPARO_ZIP_INVALIDO',
    })
  }

  const totalEntries = buf.readUInt16LE(eocdOffset + 10)
  const centralSize = buf.readUInt32LE(eocdOffset + 12)
  const centralOffset = buf.readUInt32LE(eocdOffset + 16)

  if (totalEntries > MAX_ENTRIES) {
    throw Object.assign(
      new Error(`ZIP com demasiadas entradas internas (${totalEntries}). Possível ZIP bomb.`),
      { status: 400, code: 'DISPARO_ZIP_BOMB' },
    )
  }
  if (centralOffset + 46 > buf.length || centralSize > buf.length) {
    throw Object.assign(new Error('Central directory ZIP fora dos limites do arquivo.'), {
      status: 400,
      code: 'DISPARO_ZIP_INVALIDO',
    })
  }

  const names = []
  let totalUncompressed = 0
  let offset = centralOffset

  for (let i = 0; i < totalEntries; i++) {
    if (offset + 46 > buf.length) {
      throw Object.assign(new Error('Entrada ZIP truncada no central directory.'), {
        status: 400,
        code: 'DISPARO_ZIP_INVALIDO',
      })
    }
    if (buf[offset] !== 0x50 || buf[offset + 1] !== 0x4b || buf[offset + 2] !== 0x01 || buf[offset + 3] !== 0x02) {
      throw Object.assign(new Error('Assinatura de entrada ZIP inválida.'), {
        status: 400,
        code: 'DISPARO_ZIP_INVALIDO',
      })
    }

    const uncompressed = buf.readUInt32LE(offset + 24)
    const nameLen = buf.readUInt16LE(offset + 28)
    const extraLen = buf.readUInt16LE(offset + 30)
    const commentLen = buf.readUInt16LE(offset + 32)

    if (uncompressed > MAX_SINGLE_ENTRY_DECLARED) {
      throw Object.assign(
        new Error('Entrada ZIP declara tamanho descomprimido excessivo (possível ZIP bomb).'),
        { status: 400, code: 'DISPARO_ZIP_BOMB' },
      )
    }
    totalUncompressed += uncompressed
    if (totalUncompressed > MAX_UNCOMPRESSED_DECLARED) {
      throw Object.assign(
        new Error('ZIP declara volume descomprimido excessivo (possível ZIP bomb).'),
        { status: 400, code: 'DISPARO_ZIP_BOMB' },
      )
    }

    const nameStart = offset + 46
    const nameEnd = nameStart + nameLen
    if (nameEnd > buf.length) {
      throw Object.assign(new Error('Nome de entrada ZIP truncado.'), {
        status: 400,
        code: 'DISPARO_ZIP_INVALIDO',
      })
    }
    const name = buf.slice(nameStart, nameEnd).toString('utf8')

    // Path traversal / absolute paths
    const normalized = name.replace(/\\/g, '/')
    if (
      normalized.includes('..') ||
      normalized.startsWith('/') ||
      /^[a-zA-Z]:/.test(normalized)
    ) {
      throw Object.assign(
        new Error('ZIP contém caminho interno inseguro (path traversal).'),
        { status: 400, code: 'DISPARO_ZIP_PATH_TRAVERSAL' },
      )
    }

    names.push(normalized)
    offset = nameEnd + extraLen + commentLen
  }

  return { names, entryCount: totalEntries, totalUncompressed }
}

/**
 * Classifica um arquivo com magic ZIP conforme estrutura Office Open XML.
 * @returns {'docx'|'xlsx'|'pptx'|'zip'|'unknown'}
 */
function classificarZipOffice(source) {
  const { names } = listarEntradasZip(source)
  const set = new Set(names.map((n) => n.toLowerCase()))

  const has = (p) => set.has(p) || [...set].some((n) => n === p || n.endsWith('/' + p.split('/').pop() && n.includes(p)))

  // Checagem explícita dos marcadores oficiais
  const isDocx = set.has('[content_types].xml') && (
    set.has('word/document.xml') || [...set].some((n) => n.startsWith('word/') && n.endsWith('document.xml'))
  )
  const isXlsx = set.has('[content_types].xml') && (
    set.has('xl/workbook.xml') || [...set].some((n) => n.startsWith('xl/') && n.endsWith('workbook.xml'))
  )
  const isPptx = set.has('[content_types].xml') && (
    set.has('ppt/presentation.xml') || [...set].some((n) => n.startsWith('ppt/') && n.endsWith('presentation.xml'))
  )

  if (isDocx && !isXlsx && !isPptx) return 'docx'
  if (isXlsx && !isDocx && !isPptx) return 'xlsx'
  if (isPptx && !isDocx && !isXlsx) return 'pptx'
  if (isDocx || isXlsx || isPptx) {
    // Ambíguo — preferir o que tiver o marcador canônico
    if (set.has('word/document.xml')) return 'docx'
    if (set.has('xl/workbook.xml')) return 'xlsx'
    if (set.has('ppt/presentation.xml')) return 'pptx'
  }

  // ZIP genérico (não Office)
  void has
  return 'zip'
}

/**
 * Valida extensão declarada contra conteúdo ZIP real.
 * ZIP comum NÃO pode ser aceito como DOCX/XLSX/PPTX só pela assinatura PK.
 * @param {string|Buffer} source
 * @param {string} ext - extensão sem ponto (docx, xlsx, pptx, zip)
 * @returns {{ ok: boolean, formatoReal: string, error?: string, code?: string }}
 */
function validarOfficeOuZip(source, ext) {
  const e = String(ext || '').toLowerCase().replace(/^\./, '')
  let formatoReal
  try {
    formatoReal = classificarZipOffice(source)
  } catch (err) {
    return {
      ok: false,
      formatoReal: 'unknown',
      error: err.message,
      code: err.code || 'DISPARO_ZIP_INVALIDO',
    }
  }

  if (e === 'docx' && formatoReal !== 'docx') {
    return {
      ok: false,
      formatoReal,
      error: `Arquivo declarado como DOCX, mas a estrutura interna é ${formatoReal}. Esperado word/document.xml.`,
      code: 'DISPARO_OFFICE_MISMATCH',
    }
  }
  if (e === 'xlsx' && formatoReal !== 'xlsx') {
    return {
      ok: false,
      formatoReal,
      error: `Arquivo declarado como XLSX, mas a estrutura interna é ${formatoReal}. Esperado xl/workbook.xml.`,
      code: 'DISPARO_OFFICE_MISMATCH',
    }
  }
  if (e === 'pptx' && formatoReal !== 'pptx') {
    return {
      ok: false,
      formatoReal,
      error: `Arquivo declarado como PPTX, mas a estrutura interna é ${formatoReal}. Esperado ppt/presentation.xml.`,
      code: 'DISPARO_OFFICE_MISMATCH',
    }
  }
  // zip genérico: aceito apenas se extensão for zip
  if (e === 'zip' && (formatoReal === 'docx' || formatoReal === 'xlsx' || formatoReal === 'pptx')) {
    // Office renomeado como .zip — ainda é um ZIP válido; aceitar como zip
    return { ok: true, formatoReal: 'zip' }
  }
  if (['docx', 'xlsx', 'pptx', 'zip'].includes(e)) {
    return { ok: true, formatoReal }
  }
  return { ok: true, formatoReal }
}

module.exports = {
  listarEntradasZip,
  classificarZipOffice,
  validarOfficeOuZip,
  MAX_ENTRIES,
  MAX_UNCOMPRESSED_DECLARED,
}
