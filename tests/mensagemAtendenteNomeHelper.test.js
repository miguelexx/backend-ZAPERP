const assert = require('node:assert/strict')
const {
  stripPrefixoAtendenteNoTexto,
  textosOutboundFromMeEquivalentes,
  formatTextoWhatsappComNomeAtendente,
  extrairNomePrefixoTexto,
} = require('../helpers/mensagemAtendenteNomeHelper')

test('stripPrefixoAtendenteNoTexto remove *Nome:* e linha em branco', () => {
  assert.equal(
    stripPrefixoAtendenteNoTexto('*Pollyana:*\n\nBoa tarde', 'Pollyana'),
    'Boa tarde'
  )
})

test('stripPrefixoAtendenteNoTexto remove formato legado *Nome*', () => {
  assert.equal(
    stripPrefixoAtendenteNoTexto('*Pollyana*\nBoa tarde', 'Pollyana'),
    'Boa tarde'
  )
})

test('textosOutboundFromMeEquivalentes casa webhook prefixado com CRM sem prefixo', () => {
  assert.equal(
    textosOutboundFromMeEquivalentes(
      '*Pollyana:*\n\nWillian, boa tarde',
      'Willian, boa tarde',
      'Pollyana'
    ),
    true
  )
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
  assert.equal(extrairNomePrefixoTexto('*João:*\n\nOi'), 'João')
  assert.equal(extrairNomePrefixoTexto('*João*\nOi'), 'João')
})

test('formatTextoWhatsappComNomeAtendente prefixa com : e linha em branco', () => {
  assert.equal(formatTextoWhatsappComNomeAtendente('Olá', 'Maria'), '*Maria:*\n\nOlá')
  assert.equal(formatTextoWhatsappComNomeAtendente('', 'Maria'), '*Maria:*')
  assert.equal(formatTextoWhatsappComNomeAtendente('Olá', ''), 'Olá')
  assert.equal(
    formatTextoWhatsappComNomeAtendente('*Maria:*\n\nOlá', 'Maria'),
    '*Maria:*\n\nOlá'
  )
  assert.equal(
    formatTextoWhatsappComNomeAtendente('*Maria*\nOlá', 'Maria'),
    '*Maria*\nOlá'
  )
})
