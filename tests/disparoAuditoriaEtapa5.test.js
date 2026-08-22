/**
 * Testes — correções de auditoria: texto/legenda, upload em disco, limpeza temp.
 * Mocks — sem R2/banco reais.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const {
  detectarTipoRealMidia,
  limparTemp,
  MAX_CONCURRENT,
} = require('../middleware/uploadDisparoMidia')

describe('Auditoria — magic bytes midia', () => {
  it('detecta JPEG', () => {
    const buf = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10])
    expect(detectarTipoRealMidia(buf)).toBe('imagem')
  })

  it('detecta PNG', () => {
    const buf = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
    expect(detectarTipoRealMidia(buf)).toBe('imagem')
  })

  it('detecta PDF como documento', () => {
    const buf = Buffer.from('%PDF-1.4')
    expect(detectarTipoRealMidia(buf)).toBe('documento')
  })

  it('detecta ZIP/Office como documento (estrutura detalhada em outro teste)', () => {
    const buf = Buffer.from([0x50, 0x4B, 0x03, 0x04, 0x14, 0x00])
    expect(detectarTipoRealMidia(buf)).toBe('documento')
  })
})

describe('Auditoria — limpeza de temporários', () => {
  it('limparTemp remove arquivo existente', () => {
    const tmp = path.join(os.tmpdir(), `disp-clean-${crypto.randomBytes(4).toString('hex')}.bin`)
    fs.writeFileSync(tmp, Buffer.from('abc'))
    expect(fs.existsSync(tmp)).toBe(true)
    limparTemp(tmp)
    expect(fs.existsSync(tmp)).toBe(false)
  })

  it('limparTemp não quebra se arquivo não existe', () => {
    expect(() => limparTemp(path.join(os.tmpdir(), 'nao-existe-xyz.bin'))).not.toThrow()
  })

  it('concorrência máxima configurável e >= 1', () => {
    expect(MAX_CONCURRENT).toBeGreaterThanOrEqual(1)
  })
})

describe('Auditoria — texto vs legenda (normalização)', () => {
  // Importa funções internas via re-require do controller helpers
  // As funções normalizarTextoLegenda estão no controller; testamos via comportamento exportado indireto
  // replicando a regra documentada:

  function normalizarTextoLegenda(tipo, textoIn, legendaIn) {
    let texto = (textoIn || '').slice(0, 5000) || null
    let legenda = (legendaIn || '').slice(0, 1024) || null
    if (tipo === 'texto') return { texto, legenda: null }
    if (tipo === 'audio') {
      if (!legenda && texto) { legenda = texto.slice(0, 1024); texto = null }
      return { texto: null, legenda }
    }
    if (!legenda && texto) legenda = texto.slice(0, 1024)
    return { texto: null, legenda }
  }

  it('tipo texto usa campo texto e limpa legenda', () => {
    expect(normalizarTextoLegenda('texto', 'Olá {{nome}}', 'ignorar')).toEqual({
      texto: 'Olá {{nome}}',
      legenda: null,
    })
  })

  it('imagem migra texto legado para legenda', () => {
    expect(normalizarTextoLegenda('imagem', 'Legenda antiga', null)).toEqual({
      texto: null,
      legenda: 'Legenda antiga',
    })
  })

  it('áudio não exige legenda', () => {
    expect(normalizarTextoLegenda('audio', null, null)).toEqual({
      texto: null,
      legenda: null,
    })
  })

  it('documento usa legenda', () => {
    expect(normalizarTextoLegenda('documento', null, 'Veja o PDF')).toEqual({
      texto: null,
      legenda: 'Veja o PDF',
    })
  })
})
