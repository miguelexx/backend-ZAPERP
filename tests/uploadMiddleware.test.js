const assert = require('node:assert/strict')
const {
  isAllowedUploadFile,
  extFromOriginalName,
  isBlockedRiskExtension,
  blockedUploadErrorMessage,
  uploadValidationError,
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

test('mensagem de bloqueio menciona zip', () => {
  assert.match(blockedUploadErrorMessage('exe'), /zip/i)
})

test('erro de upload inválido carrega status 400', () => {
  const err = uploadValidationError('Arquivo inválido', 'UPLOAD_TEST')
  assert.equal(err.status, 400)
  assert.equal(err.code, 'UPLOAD_TEST')
})

test('extFromOriginalName', () => {
  assert.equal(extFromOriginalName('Firebird-3.0.14.33856-0-x64.exe'), 'exe')
})
