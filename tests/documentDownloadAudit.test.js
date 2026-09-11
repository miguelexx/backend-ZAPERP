/**
 * Auditoria documentos (2026-09-11): enviar PDF/DOCX/… e SALVAR arquivos com o nome e o formato certos.
 *  - /uploads aceita ?filename=&disposition= (antes "Salvar como…" gravava o nome técnico do disco);
 *  - Content-Disposition nunca derruba a resposta com nome fora do Latin-1 (—, “ ”, emoji);
 *  - /media/proxy com esse tipo de nome respondia 502;
 *  - formatos de escritório comuns (odt, ods, ofx…) passam no upload; executável continua bloqueado;
 *  - documento recebido pela UltraMSG usa o texto como nome quando o texto É o nome do arquivo.
 */

const fs = require('fs')
const path = require('path')
const http = require('http')
const express = require('express')
const request = require('supertest')
const {
  sanitizeDownloadFilename,
  buildContentDisposition,
  asciiFallbackFilename,
} = require('../helpers/contentDisposition')

function rawBuffer(req) {
  return req.buffer(true).parse((res, cb) => {
    const chunks = []
    res.on('data', (c) => chunks.push(c))
    res.on('end', () => cb(null, Buffer.concat(chunks)))
  })
}

describe('helpers/contentDisposition', () => {
  test('sanitiza nome vindo de query/DB', () => {
    expect(sanitizeDownloadFilename('../../etc/passwd')).toBe('passwd')
    expect(sanitizeDownloadFilename('C:\\Users\\x\\Relatório.pdf')).toBe('Relatório.pdf')
    expect(sanitizeDownloadFilename('a"b<c>|d.pdf')).toBe('abcd.pdf')
    expect(sanitizeDownloadFilename('linha\r\nquebrada.pdf')).toBe('linhaquebrada.pdf')
    expect(sanitizeDownloadFilename('...')).toBeNull()
    expect(sanitizeDownloadFilename('')).toBeNull()
    expect(sanitizeDownloadFilename(null)).toBeNull()
  })

  test('sem extensão herda a do arquivo real; .bin nunca é colado', () => {
    expect(sanitizeDownloadFilename('Contrato', { fallbackExt: '.pdf' })).toBe('Contrato.pdf')
    expect(sanitizeDownloadFilename('Arquivo', { fallbackExt: '.bin' })).toBe('Arquivo')
    // Nome com extensão própria prevalece (corrige arquivo gravado como .bin).
    expect(sanitizeDownloadFilename('extrato.ofx', { fallbackExt: '.bin' })).toBe('extrato.ofx')
  })

  test('nome enorme é cortado preservando a extensão', () => {
    const s = sanitizeDownloadFilename(`${'a'.repeat(400)}.xlsx`)
    expect(s.length).toBeLessThanOrEqual(180)
    expect(s.endsWith('.xlsx')).toBe(true)
  })

  test('header com —, aspas curvas e emoji não lança (antes: ERR_INVALID_CHAR)', () => {
    const res = new http.ServerResponse({ method: 'GET' })
    for (const n of ['Relatório — final.pdf', 'Orçamento “novo”.xlsx', 'foto 😀.jpg', "O'Brien (1).docx"]) {
      const header = buildContentDisposition('attachment', n)
      expect(() => res.setHeader('Content-Disposition', header)).not.toThrow()
      expect(header).toContain(`filename*=UTF-8''${encodeURIComponent(n).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`)
    }
    expect(asciiFallbackFilename('Relatório — final.pdf')).toBe('Relatorio _ final.pdf')
    expect(buildContentDisposition('inline', 'a.pdf')).toMatch(/^inline; filename="a\.pdf"; filename\*=UTF-8''a\.pdf$/)
  })
})

describe('GET /uploads — "Salvar como…" com nome real', () => {
  const app = require('../app')
  const { ensureUploadsRootExists } = require('../config/uploadsRoot')
  const created = []

  function writeUpload(name, content = 'conteudo') {
    const root = ensureUploadsRootExists()
    const fileName = `dl-audit-${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${name}`
    const full = path.join(root, fileName)
    fs.writeFileSync(full, Buffer.from(content))
    created.push(full)
    return fileName
  }

  afterAll(() => {
    for (const f of created) { try { fs.unlinkSync(f) } catch { /* ignore */ } }
  })

  test('sem parâmetros: comportamento idêntico ao anterior (nome técnico + octet-stream)', async () => {
    const f = writeUpload('x.docx')
    const r = await request(app).get(`/uploads/${f}`)
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toMatch(/^application\/octet-stream/)
    expect(r.headers['content-disposition']).toBe(`attachment; filename="${f.toLowerCase()}"`)
  })

  test('DOCX com ?filename= salva com o nome real (UTF-8) e continua download seguro', async () => {
    const f = writeUpload('x.docx')
    const r = await request(app).get(`/uploads/${f}`).query({ filename: 'Contrato Social — 2026.docx', disposition: 'attachment' })
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toMatch(/^application\/octet-stream/)
    expect(r.headers['content-disposition']).toMatch(/^attachment; filename="Contrato Social _ 2026\.docx"; filename\*=UTF-8''Contrato%20Social%20%E2%80%94%202026\.docx$/)
  })

  test('arquivo gravado como .bin baixa com a extensão real do nome', async () => {
    const f = writeUpload('x.bin')
    const r = await request(app).get(`/uploads/${f}`).query({ filename: 'extrato.ofx', disposition: 'attachment' })
    expect(r.headers['content-disposition']).toContain("filename*=UTF-8''extrato.ofx")
  })

  test('.html com filename continua download octet-stream (não renderiza)', async () => {
    const f = writeUpload('x.html', '<script>alert(1)</script>')
    const r = await request(app).get(`/uploads/${f}`).query({ filename: 'pagina.html', disposition: 'inline' })
    expect(r.headers['content-type']).toMatch(/^application\/octet-stream/)
    expect(r.headers['content-disposition']).toMatch(/^attachment;/)
  })

  test('PDF: inline por padrão com nome; attachment quando pedido; sem parâmetro sem header', async () => {
    const f = writeUpload('x.pdf', '%PDF-1.4\n%%EOF\n')
    const semParam = await rawBuffer(request(app).get(`/uploads/${f}`))
    expect(semParam.headers['content-disposition']).toBeUndefined()
    const abrir = await rawBuffer(request(app).get(`/uploads/${f}`).query({ filename: 'Boleto março.pdf', disposition: 'inline' }))
    expect(abrir.headers['content-type']).toMatch(/^application\/pdf/)
    expect(abrir.headers['content-disposition']).toMatch(/^inline; .*filename\*=UTF-8''Boleto%20mar%C3%A7o\.pdf$/)
    const salvar = await rawBuffer(request(app).get(`/uploads/${f}`).query({ filename: 'Boleto março', disposition: 'attachment' }))
    expect(salvar.headers['content-disposition']).toMatch(/^attachment; .*filename\*=UTF-8''Boleto%20mar%C3%A7o\.pdf$/)
  })

  test('nome com emoji não derruba a resposta', async () => {
    const f = writeUpload('x.jpg')
    const r = await request(app).get(`/uploads/${f}`).query({ filename: 'foto 😀.jpg', disposition: 'attachment' })
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toMatch(/^image\/jpeg/)
  })
})

describe('GET /media/proxy — nome fora do Latin-1', () => {
  const previousFetch = global.fetch
  afterEach(() => { global.fetch = previousFetch })

  test('"Relatório — final.pdf" responde 200 (antes: 502 por ERR_INVALID_CHAR)', async () => {
    global.fetch = jest.fn(async () => new Response(Buffer.from('%PDF-1.4\n%%EOF\n'), {
      status: 200,
      headers: { 'Content-Type': 'application/pdf' },
    }))
    const app = express()
    app.get('/media/proxy', require('../controllers/mediaProxyController').proxyMedia)
    const r = await rawBuffer(request(app).get('/media/proxy').query({
      url: 'https://ultramsgmedia.s3.amazonaws.com/instance15/doc',
      filename: 'Relatório — final.pdf',
      disposition: 'attachment',
    }))
    expect(r.status).toBe(200)
    expect(r.headers['content-disposition']).toMatch(/^attachment; filename="Relatorio _ final\.pdf"; filename\*=UTF-8''Relat%C3%B3rio%20%E2%80%94%20final\.pdf$/)
  })
})

describe('upload — formatos de documento', () => {
  const { isAllowedUploadFile } = require('../middleware/upload')
  const { inferirTipoArquivo } = require('../services/chat/media/mediaType')

  test.each([
    ['proposta.odt', 'application/vnd.oasis.opendocument.text'],
    ['planilha.ods', 'application/vnd.oasis.opendocument.spreadsheet'],
    ['extrato.ofx', 'application/x-ofx'],
    ['remessa.rem', ''],
    ['retorno.ret', 'application/octet-stream'],
    ['email.eml', 'message/rfc822'],
    ['contato.vcf', 'text/vcard'],
    ['backup.tar', 'application/x-tar'],
    ['relatorio.pdf', 'application/pdf'],
    ['nota.xml', 'text/xml'],
  ])('%s é aceito e vai como documento', (originalname, mimetype) => {
    const file = { originalname, mimetype, fieldname: 'file' }
    expect(isAllowedUploadFile(file)).toBe(true)
    expect(inferirTipoArquivo(file)).toBe('arquivo')
  })

  test.each([['virus.exe'], ['app.apk'], ['script.bat'], ['macro.vbs']])('%s continua bloqueado', (originalname) => {
    expect(isAllowedUploadFile({ originalname, mimetype: 'application/octet-stream', fieldname: 'file' })).toBe(false)
  })
})

describe('documento recebido — nome a partir do texto (UltraMSG sem fileName)', () => {
  const { applyInboundMediaFields, nomeArquivoDoTexto } = require('../controllers/webhookInbound/persistMensagem')
  const base = (texto) => ({ conversa_id: 1, texto, direcao: 'in', company_id: 1 })

  test('texto que é nome de arquivo vira nome_arquivo', () => {
    const m = applyInboundMediaFields(base('Contrato Social 2026.pdf'), { type: 'document', documentUrl: 'https://x/d' })
    expect(m.nome_arquivo).toBe('Contrato Social 2026.pdf')
  })

  test('fileName do provider continua mandando', () => {
    const m = applyInboundMediaFields(base('Contrato.pdf'), { type: 'document', documentUrl: 'https://x/d', fileName: 'oficial.pdf' })
    expect(m.nome_arquivo).toBe('oficial.pdf')
  })

  test('legenda comum / placeholder / URL não viram nome', () => {
    expect(nomeArquivoDoTexto('Segue o contrato, confere por favor')).toBeNull()
    expect(nomeArquivoDoTexto('(arquivo)')).toBeNull()
    expect(nomeArquivoDoTexto('https://site.com/a.pdf')).toBeNull()
    expect(nomeArquivoDoTexto('baixe em https://site.com/a.pdf')).toBeNull()
    expect(nomeArquivoDoTexto('linha 1\nnota.pdf')).toBeNull()
    expect(nomeArquivoDoTexto('visite site.com')).toBeNull()
    const m = applyInboundMediaFields(base('Segue o contrato'), { type: 'document', documentUrl: 'https://x/d' })
    expect(m.nome_arquivo).toBe('arquivo')
  })
})

describe('documento recebido — extensão preservada na cópia local', () => {
  const { _test } = require('../services/inboundMediaPersistenceService')
  test.each([['extrato.ofx', '.ofx'], ['proposta.odt', '.odt'], ['planilha.xlsm', '.xlsm'], ['email.eml', '.eml']])('%s', (nome, ext) => {
    const r = _test.pickStoredFilename({ company_id: 1, mensagem_id: 2, contentType: 'application/octet-stream', nome_arquivo: nome, tipo: 'arquivo', buffer: Buffer.from('x') })
    expect(r.filename.endsWith(ext)).toBe(true)
  })
  test('imagem com nome .heic continua indo para .jpg (miniatura da bolha não quebra)', () => {
    const r = _test.pickStoredFilename({ company_id: 1, mensagem_id: 2, contentType: 'application/octet-stream', nome_arquivo: 'foto.heic', tipo: 'imagem', buffer: Buffer.from('x') })
    expect(r.filename.endsWith('.jpg')).toBe(true)
  })
})
