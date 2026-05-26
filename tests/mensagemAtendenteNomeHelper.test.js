const assert = require('node:assert/strict')
const {
  stripPrefixoAtendenteNoTexto,
  textosOutboundFromMeEquivalentes,
  formatTextoWhatsappComNomeAtendente,
  extrairNomePrefixoTexto,
} = require('../helpers/mensagemAtendenteNomeHelper')

test('stripPrefixoAtendenteNoTexto remove *Nome* na primeira linha', () => {
  assert.equal(
    stripPrefixoAtendenteNoTexto('*Pollyana*\nBoa tarde', 'Pollyana'),
    'Boa tarde'
  )
})

test('textosOutboundFromMeEquivalentes casa webhook prefixado com CRM sem prefixo', () => {
  assert.equal(
    textosOutboundFromMeEquivalentes(
      '*Pollyana*\nWillian, boa tarde',
      'Willian, boa tarde',
      'Pollyana'
    ),
    true
  )
})

test('extrairNomePrefixoTexto', () => {
  assert.equal(extrairNomePrefixoTexto('*João*\nOi'), 'João')
})

test('formatTextoWhatsappComNomeAtendente prefixa e evita duplicar', () => {
  assert.equal(formatTextoWhatsappComNomeAtendente('Olá', 'Maria'), '*Maria*\nOlá')
  assert.equal(formatTextoWhatsappComNomeAtendente('', 'Maria'), '*Maria*')
  assert.equal(formatTextoWhatsappComNomeAtendente('Olá', ''), 'Olá')
  assert.equal(
    formatTextoWhatsappComNomeAtendente('*Maria*\nOlá', 'Maria'),
    '*Maria*\nOlá'
  )
})
