const assert = require('node:assert/strict')
const {
  isAllowedUploadFile,
  extFromOriginalName,
  isBlockedRiskExtension,
  blockedUploadErrorMessage,
  uploadValidationError,
  UPLOAD_MAX_FILE_MB,
  UPLOAD_MAX_FILE_BYTES,
} = require('../middleware/upload')

test('aceita application/json', () => {
  assert.equal(
    isAllowedUploadFile({ mimetype: 'application/json', originalname: 'config.json', fieldname: 'file' }),
    true
  )
})

test('rejeita .exe (alto risco WhatsApp)', () => {
  assert.equal(isBlockedRiskExtension('exe'), true)
  assert.equal(
    isAllowedUploadFile({
      mimetype: 'application/octet-stream',
      originalname: 'setup.exe',
      fieldname: 'file',
    }),
    false
  )
})

test('rejeita .apk', () => {
  assert.equal(
    isAllowedUploadFile({
      mimetype: 'application/vnd.android.package-archive',
      originalname: 'app.apk',
      fieldname: 'file',
    }),
    false
  )
})

test('rejeita .sh (script de shell)', () => {
  assert.equal(isBlockedRiskExtension('sh'), true)
  assert.equal(
    isAllowedUploadFile({
      mimetype: 'text/x-shellscript',
      originalname: 'deploy.sh',
      fieldname: 'file',
    }),
    false
  )
})

test('aceita imagens HEIC/HEIF de celular', () => {
  assert.equal(
    isAllowedUploadFile({ mimetype: 'image/heic', originalname: 'IMG_001.HEIC', fieldname: 'file' }),
    true
  )
  assert.equal(
    isAllowedUploadFile({ mimetype: 'application/octet-stream', originalname: 'IMG_002.heif', fieldname: 'file' }),
    true
  )
})

test('aceita videos MOV/M4V de celular por MIME ou extensao', () => {
  assert.equal(
    isAllowedUploadFile({ mimetype: 'video/quicktime', originalname: 'IMG_003.mov', fieldname: 'file' }),
    true
  )
  assert.equal(
    isAllowedUploadFile({ mimetype: 'application/octet-stream', originalname: 'clip.m4v', fieldname: 'file' }),
    true
  )
})

test('mensagem de bloqueio menciona zip', () => {
  assert.match(blockedUploadErrorMessage('exe'), /zip/i)
})

test('erro de upload inválido carrega status 400', () => {
  const err = uploadValidationError('Arquivo inválido', 'UPLOAD_TEST')
  assert.equal(err.status, 400)
  assert.equal(err.code, 'UPLOAD_TEST')
})

test('limite padrão de upload aceita o anexo de 102,6 MB do caso reportado', () => {
  assert.equal(UPLOAD_MAX_FILE_BYTES, UPLOAD_MAX_FILE_MB * 1024 * 1024)
  assert.ok(UPLOAD_MAX_FILE_BYTES > 102.6 * 1024 * 1024)
})

test('extFromOriginalName', () => {
  assert.equal(extFromOriginalName('Firebird-3.0.14.33856-0-x64.exe'), 'exe')
})
