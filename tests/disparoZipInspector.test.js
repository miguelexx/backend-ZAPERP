/**
 * Testes unitários — inspeção ZIP/Office e proteção ZIP bomb / path traversal.
 * Sem banco, sem R2, sem UltraMSG.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const {
  listarEntradasZip,
  classificarZipOffice,
  validarOfficeOuZip,
} = require('../helpers/disparoZipInspector')

/** Monta um ZIP mínimo válido com entradas (sem compressão). */
function buildZip(entries) {
  const localParts = []
  const centralParts = []
  let offset = 0

  for (const { name, content } of entries) {
    const nameBuf = Buffer.from(name, 'utf8')
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content || '')
    const local = Buffer.alloc(30 + nameBuf.length + data.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(0, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    nameBuf.copy(local, 30)
    data.copy(local, 30 + nameBuf.length)
    localParts.push(local)

    const central = Buffer.alloc(46 + nameBuf.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(0, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    nameBuf.copy(central, 46)
    centralParts.push(central)

    offset += local.length
  }

  const centralDir = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralDir.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...localParts, centralDir, eocd])
}

describe('disparoZipInspector — Office e ZIP', () => {
  it('classifica DOCX pela presença de word/document.xml', () => {
    const buf = buildZip([
      { name: '[Content_Types].xml', content: '<Types/>' },
      { name: 'word/document.xml', content: '<w:document/>' },
    ])
    expect(classificarZipOffice(buf)).toBe('docx')
    expect(validarOfficeOuZip(buf, 'docx').ok).toBe(true)
  })

  it('classifica XLSX por xl/workbook.xml', () => {
    const buf = buildZip([
      { name: '[Content_Types].xml', content: '<Types/>' },
      { name: 'xl/workbook.xml', content: '<workbook/>' },
    ])
    expect(classificarZipOffice(buf)).toBe('xlsx')
    expect(validarOfficeOuZip(buf, 'xlsx').ok).toBe(true)
  })

  it('classifica PPTX por ppt/presentation.xml', () => {
    const buf = buildZip([
      { name: '[Content_Types].xml', content: '<Types/>' },
      { name: 'ppt/presentation.xml', content: '<p:presentation/>' },
    ])
    expect(classificarZipOffice(buf)).toBe('pptx')
  })

  it('ZIP comum NÃO passa como DOCX', () => {
    const buf = buildZip([{ name: 'readme.txt', content: 'ola' }])
    expect(classificarZipOffice(buf)).toBe('zip')
    const r = validarOfficeOuZip(buf, 'docx')
    expect(r.ok).toBe(false)
    expect(r.code).toBe('DISPARO_OFFICE_MISMATCH')
  })

  it('rejeita path traversal ../ no ZIP', () => {
    const buf = buildZip([{ name: '../evil.txt', content: 'x' }])
    expect(() => listarEntradasZip(buf)).toThrow(/path traversal|inseguro/i)
  })

  it('rejeita ZIP bomb por tamanho descomprimido declarado excessivo', () => {
    // Entrada com uncompressed size gigante no central directory
    const name = Buffer.from('bomb.bin')
    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(name.length, 26)
    name.copy(local, 30)

    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt32LE(0, 20) // compressed
    central.writeUInt32LE(0xFFFFFFFF, 24) // uncompressed enorme
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(0, 42)
    name.copy(central, 46)

    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(1, 8)
    eocd.writeUInt16LE(1, 10)
    eocd.writeUInt32LE(central.length, 12)
    eocd.writeUInt32LE(local.length, 16)

    const buf = Buffer.concat([local, central, eocd])
    expect(() => listarEntradasZip(buf)).toThrow(/ZIP bomb|excessivo/i)
  })

  it('funciona a partir de arquivo temporário em disco', () => {
    const buf = buildZip([
      { name: '[Content_Types].xml', content: '<Types/>' },
      { name: 'word/document.xml', content: '<w:document/>' },
    ])
    const tmp = path.join(os.tmpdir(), `zip-test-${crypto.randomBytes(4).toString('hex')}.docx`)
    fs.writeFileSync(tmp, buf)
    try {
      expect(classificarZipOffice(tmp)).toBe('docx')
    } finally {
      fs.unlinkSync(tmp)
    }
  })
})
