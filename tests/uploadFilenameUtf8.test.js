/**
 * Nome de arquivo enviado pelo atendente precisa chegar em UTF-8.
 *
 * O busboy (via multer) decodifica o `filename` do multipart como latin1 por padrão, então
 * "Orçamento - 8901.pdf" (que o browser manda em bytes UTF-8) virava "OrÃ§amento - 8901.pdf"
 * em `file.originalname` — e esse nome ia para `nome_arquivo` (card/thread) e para o próprio
 * documento entregue no WhatsApp. O fix é `defParamCharset: 'utf8'` no multer de upload.
 *
 * Simula o corpo multipart com os bytes do filename em UTF-8, como um browser real faz.
 */

const express = require('express')
const request = require('supertest')
const { upload } = require('../middleware/upload')

function buildMultipartBody(boundary, fieldname, filename, contentType, content) {
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${fieldname}"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
    'utf8'
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
  return Buffer.concat([head, Buffer.from(content, 'utf8'), tail])
}

function makeApp() {
  const app = express()
  app.post('/up', upload.any(), (req, res) => {
    res.json({ originalname: (req.files && req.files[0] && req.files[0].originalname) || null })
  })
  return app
}

describe('upload multipart — filename em UTF-8', () => {
  test('cedilha e travessão chegam intactos (sem mojibake)', async () => {
    const boundary = 'BoundaryZapERP'
    const nome = 'Orçamento - 8901.pdf'
    const body = buildMultipartBody(boundary, 'arquivo', nome, 'application/pdf', '%PDF-1.4 fake')

    const res = await request(makeApp())
      .post('/up')
      .set('Content-Type', `multipart/form-data; boundary=${boundary}`)
      .send(body)

    expect(res.status).toBe(200)
    expect(res.body.originalname).toBe(nome)
    expect(res.body.originalname).not.toContain('Ã') // mojibake clássico de latin1
  })

  test('acentos diversos preservados', async () => {
    const boundary = 'BoundaryAcentos'
    const nome = 'Relatório de Produção — Março.docx'
    const body = buildMultipartBody(
      boundary,
      'arquivo',
      nome,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'fake'
    )

    const res = await request(makeApp())
      .post('/up')
      .set('Content-Type', `multipart/form-data; boundary=${boundary}`)
      .send(body)

    expect(res.status).toBe(200)
    expect(res.body.originalname).toBe(nome)
  })
})
