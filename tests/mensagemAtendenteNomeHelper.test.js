const assert = require('node:assert/strict')
const {
  stripPrefixoAtendenteNoTexto,
  textosOutboundFromMeEquivalentes,
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
