const test = require('node:test')
const assert = require('node:assert/strict')
const {
  textoMensagemMidiaParaBanco,
  captionWhatsappParaMidia,
} = require('../helpers/midiaMensagemHelper')

test('textoMensagemMidiaParaBanco: imagem sem legenda usa placeholder', () => {
  assert.equal(
    textoMensagemMidiaParaBanco({
      tipo: 'imagem',
      captionUsuarioTrim: '',
      originalname: 'ChatGPT Image 20 de mai. de 2026.png',
    }),
    '(imagem)'
  )
})

test('textoMensagemMidiaParaBanco: imagem com legenda do atendente', () => {
  assert.equal(
    textoMensagemMidiaParaBanco({
      tipo: 'imagem',
      captionUsuarioTrim: 'Olá!',
      originalname: 'foto.png',
    }),
    'Olá!'
  )
})

test('textoMensagemMidiaParaBanco: arquivo mantém nome', () => {
  assert.equal(
    textoMensagemMidiaParaBanco({
      tipo: 'arquivo',
      captionUsuarioTrim: '',
      originalname: 'relatorio.pdf',
    }),
    'relatorio.pdf'
  )
})

test('captionWhatsappParaMidia: imagem sem legenda retorna vazio', () => {
  assert.equal(
    captionWhatsappParaMidia({
      tipo: 'imagem',
      captionUsuarioTrim: '',
      usuarioNome: 'Pollyana',
    }),
    ''
  )
})

test('captionWhatsappParaMidia: imagem com legenda inclui rodapé', () => {
  assert.equal(
    captionWhatsappParaMidia({
      tipo: 'imagem',
      captionUsuarioTrim: 'Promoção',
      usuarioNome: 'Pollyana',
    }),
    'Promoção\n— Pollyana'
  )
})

test('captionWhatsappParaMidia: documento sem legenda usa rodapé ou espaço', () => {
  assert.equal(
    captionWhatsappParaMidia({
      tipo: 'arquivo',
      captionUsuarioTrim: '',
      usuarioNome: 'Ana',
    }),
    '— Ana'
  )
  assert.equal(
    captionWhatsappParaMidia({
      tipo: 'arquivo',
      captionUsuarioTrim: '',
      usuarioNome: '',
    }),
    ' '
  )
})
