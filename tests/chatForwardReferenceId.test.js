const assert = require('node:assert/strict')
const { _test } = require('../controllers/chatController')

/**
 * Regressão: todo envio de encaminhamento precisa propagar referenceId (crm-<id>)
 * para o provider. Sem isso o eco fromMe do webhook não reconcilia com a linha já
 * persistida e a mensagem aparece duplicada no chat (mesmo bug do cartão de contato).
 */

function fakeSupabase(insertedIdRef) {
  const makeChain = () => {
    const chain = {
      _payload: null,
      insert(p) {
        this._payload = p
        return this
      },
      update() {
        return this
      },
      select() {
        return this
      },
      eq() {
        return this
      },
      single() {
        const row = { id: insertedIdRef.value, ...(this._payload || {}) }
        return Promise.resolve({ data: row, error: null })
      },
      then(resolve, reject) {
        return Promise.resolve({ data: null, error: null }).then(resolve, reject)
      },
    }
    return chain
  }
  return { from: () => makeChain() }
}

function baseCtx({ provider, mensagemOriginal, tipo_encaminhamento, insertedIdRef }) {
  return {
    io: null,
    supabase: fakeSupabase(insertedIdRef),
    company_id: 1,
    user_id: 10,
    conversa_id: 55,
    telefoneParaEnvio: '5534999999999',
    whatsappInstanceId: null,
    provider,
    usuarioNome: 'Atendente',
    mensagemOriginal,
    tipo_encaminhamento,
    timestamp: new Date().toISOString(),
  }
}

test('encaminhar texto envia referenceId crm-<id> ao provider', async () => {
  const insertedIdRef = { value: 901 }
  let capturedOpts = null
  const provider = {
    sendText: async (_phone, _texto, opts) => {
      capturedOpts = opts
      return { ok: true, messageId: 'false_5534999999999@c.us_3EB0ABCDEF12' }
    },
  }
  const result = await _test.encaminharUmaMensagemParaConversa(
    baseCtx({
      provider,
      mensagemOriginal: { texto: 'Mensagem de texto original', tipo: 'texto' },
      tipo_encaminhamento: 'texto',
      insertedIdRef,
    })
  )
  assert.equal(result.ok, true)
  assert.ok(capturedOpts, 'provider.sendText deve ser chamado')
  assert.equal(capturedOpts.referenceId, 'crm-901')
})

test('encaminhar localização envia referenceId crm-<id> ao provider', async () => {
  const insertedIdRef = { value: 902 }
  let capturedOpts = null
  const provider = {
    sendLocation: async (_phone, _loc, opts) => {
      capturedOpts = opts
      return { ok: true, messageId: 'false_5534999999999@c.us_3EB0ABCDEF34' }
    },
  }
  const result = await _test.encaminharUmaMensagemParaConversa(
    baseCtx({
      provider,
      mensagemOriginal: {
        texto: 'Local combinado',
        tipo: 'location',
        location_meta: { latitude: -18.9, longitude: -48.2, nome: 'Praça' },
        url: 'https://www.google.com/maps?q=-18.9,-48.2',
      },
      tipo_encaminhamento: 'location',
      insertedIdRef,
    })
  )
  assert.equal(result.ok, true)
  assert.ok(capturedOpts, 'provider.sendLocation deve ser chamado')
  assert.equal(capturedOpts.referenceId, 'crm-902')
})

test('encaminhar contato sem telefone (fallback texto) envia referenceId crm-<id>', async () => {
  const insertedIdRef = { value: 903 }
  let capturedOpts = null
  const provider = {
    sendText: async (_phone, _texto, opts) => {
      capturedOpts = opts
      return { ok: true, messageId: 'false_5534999999999@c.us_3EB0ABCDEF56' }
    },
    sendContact: async () => {
      throw new Error('não deveria chamar sendContact sem telefone do contato')
    },
  }
  const result = await _test.encaminharUmaMensagemParaConversa(
    baseCtx({
      provider,
      mensagemOriginal: { texto: 'Fulano', tipo: 'contact', contact_meta: { nome: 'Fulano' } },
      tipo_encaminhamento: 'contact',
      insertedIdRef,
    })
  )
  assert.equal(result.ok, true)
  assert.ok(capturedOpts, 'provider.sendText (fallback) deve ser chamado')
  assert.equal(capturedOpts.referenceId, 'crm-903')
})

test('encaminhar tipo não suportado (fallback texto) envia referenceId crm-<id>', async () => {
  const insertedIdRef = { value: 904 }
  let capturedOpts = null
  const provider = {
    sendText: async (_phone, _texto, opts) => {
      capturedOpts = opts
      return { ok: true, messageId: 'false_5534999999999@c.us_3EB0ABCDEF78' }
    },
  }
  const result = await _test.encaminharUmaMensagemParaConversa(
    baseCtx({
      provider,
      mensagemOriginal: { texto: 'Algo antigo', tipo: 'reaction' },
      tipo_encaminhamento: 'auto',
      insertedIdRef,
    })
  )
  assert.equal(result.ok, true)
  assert.ok(capturedOpts, 'provider.sendText (fallback) deve ser chamado')
  assert.equal(capturedOpts.referenceId, 'crm-904')
})
