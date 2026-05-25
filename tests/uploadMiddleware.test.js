const test = require('node:test')
const assert = require('node:assert/strict')
const { isAllowedUploadFile, extFromOriginalName } = require('../middleware/upload')

test('aceita application/json', () => {
  assert.equal(
    isAllowedUploadFile({ mimetype: 'application/json', originalname: 'config.json', fieldname: 'file' }),
    true
  )
})

test('aceita .exe com octet-stream', () => {
  assert.equal(
    isAllowedUploadFile({
      mimetype: 'application/octet-stream',
      originalname: 'setup.exe',
      fieldname: 'file',
    }),
    true
  )
})

test('extFromOriginalName', () => {
  assert.equal(extFromOriginalName('Firebird-3.0.14.33856-0-x64.exe'), 'exe')
})
