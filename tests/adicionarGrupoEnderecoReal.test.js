/**
 * "Não estou conseguindo adicionar ao grupo" — 10/11/2026.
 *
 * As 5 tentativas gravadas desde 09/10 falharam todas com WHATSAPP_RECUSOU. Causa medida no
 * canal: a fila manda o número DISCADO (13 dígitos) e o JID real do contato tem 12 (sem o 9º
 * dígito), então o endereço não existe e a Whapi devolve o contato em `failed`.
 *
 *   POST /contacts {"contacts":["5534999911246"]}
 *     → {"input":"5534999911246","status":"valid","wa_id":"553499911246@s.whatsapp.net"}
 *
 * Agora o endereço é resolvido antes de adicionar (enderecoWhatsappService), nos dois caminhos:
 * fila (worker) e adição direta (controller).
 */

const {
  resolverEnderecosWhatsapp,
  resolverEnderecoWhatsapp,
} = require('../services/chat/identity/enderecoWhatsappService')

describe('enderecoWhatsappService — JID real antes de agir', () => {
  test('troca o número discado pelo wa_id que o WhatsApp informou (9º dígito)', async () => {
    const provider = {
      checkPhones: jest.fn(async () => [
        { input: '5534999911246', exists: true, waId: '553499911246@s.whatsapp.net', status: 'valid' },
      ]),
    }
    const r = await resolverEnderecoWhatsapp(provider, '5534999911246', { companyId: 4, whatsappInstanceId: 4 })
    expect(r).toEqual({ original: '5534999911246', jid: '553499911246', chatId: '553499911246@s.whatsapp.net', existe: true, verificado: true })
    expect(provider.checkPhones).toHaveBeenCalledWith(['5534999911246'], { companyId: 4, whatsappInstanceId: 4 })
  })

  test('número sem WhatsApp é marcado como inexistente (não vira "anti-spam")', async () => {
    const provider = { checkPhones: jest.fn(async () => [{ input: '5534999999999', exists: false, waId: null }]) }
    const r = await resolverEnderecoWhatsapp(provider, '5534999999999', {})
    expect(r.existe).toBe(false)
    expect(r.verificado).toBe(true)
  })

  test('consulta indisponível NÃO vira "não existe" — segue com o número original', async () => {
    const provider = { checkPhones: jest.fn(async () => { throw new Error('canal fora do ar') }) }
    const r = await resolverEnderecoWhatsapp(provider, '5534999911246', {})
    expect(r).toEqual({ original: '5534999911246', jid: '5534999911246', chatId: '', existe: true, verificado: false })
  })

  test('provider sem checkPhones: comportamento antigo, uma chamada a menos', async () => {
    const r = await resolverEnderecoWhatsapp({}, '5534999911246', {})
    expect(r).toEqual({ original: '5534999911246', jid: '5534999911246', chatId: '', existe: true, verificado: false })
  })

  test('vários números numa consulta só, deduplicados e na ordem', async () => {
    const provider = {
      checkPhones: jest.fn(async () => [
        { input: '5534999911246', exists: true, waId: '553499911246@s.whatsapp.net' },
        { input: '5511988887777', exists: true, waId: '5511988887777@s.whatsapp.net' },
      ]),
    }
    const r = await resolverEnderecosWhatsapp(provider, ['5534999911246', '5511988887777', '5534999911246'], {})
    expect(provider.checkPhones).toHaveBeenCalledTimes(1)
    expect(provider.checkPhones.mock.calls[0][0]).toEqual(['5534999911246', '5511988887777'])
    expect(r.map((e) => e.jid)).toEqual(['553499911246', '5511988887777'])
  })

  test('aceita jid com sufixo e devolve só dígitos', async () => {
    const provider = { checkPhones: jest.fn(async () => []) }
    const r = await resolverEnderecoWhatsapp(provider, '5534999911246@s.whatsapp.net', {})
    expect(r.original).toBe('5534999911246')
  })
})

describe('worker da fila — adiciona no endereço certo', () => {
  let worker
  let supabaseUpdates
  let addGroupParticipant
  let checkPhones

  function montar({ waId, exists = true, respostaAdd }) {
    jest.resetModules()
    supabaseUpdates = []
    checkPhones = jest.fn(async (nums) => [{ input: nums[0], exists, waId: waId || null }])
    addGroupParticipant = jest.fn(async () => ({ ok: true, data: respostaAdd }))

    const chain = {}
    const ret = () => chain
    chain.from = ret
    chain.select = ret
    chain.eq = ret
    chain.gte = () => Promise.resolve({ count: 0 })
    chain.update = (payload) => { supabaseUpdates.push(payload); return chain }
    chain.in = () => Promise.resolve({ data: [], error: null })
    chain.maybeSingle = () => Promise.resolve({ data: { id: 'op1', status: 'em_execucao' }, error: null })
    chain.single = () => Promise.resolve({ data: {}, error: null })
    chain.rpc = jest.fn(async () => ({ data: true, error: null }))

    jest.doMock('../config/supabase', () => chain)
    jest.doMock('../services/providers', () => ({
      getProvider: () => ({ addGroupParticipant, checkPhones }),
    }))
    jest.doMock('../services/whatsappInstanceService', () => ({
      getWhatsappInstanceById: jest.fn(async () => ({ instance: { metadata: {} }, error: null })),
    }))
    jest.doMock('../services/comunidade/comunidadeFilaService', () => ({
      recalcularContadores: jest.fn(async () => ({})),
      pausarOperacaoAutomatica: jest.fn(async () => ({})),
    }))
    jest.doMock('../services/comunidade/comunidadeSocketService', () => ({ emitComunidade: jest.fn(), EVENTS: {} }))
    worker = require('../workers/comunidadeWorker')
  }

  const item = {
    id: 5, operacao_id: 'op1', company_id: 4, whatsapp_instance_id: 4,
    comunidade_id: '120363414979314769@g.us', operacao: 'add', tipo: 'grupo',
    participante_jid: '5534999911246', tentativas: 0, max_tentativas: 5,
  }

  const finalizacao = () => supabaseUpdates.find((u) => u && u.resultado != null)

  afterEach(() => jest.resetModules())

  test('manda o JID completo do wa_id — o adapter reescreveria o número cru', async () => {
    montar({ waId: '553499911246@s.whatsapp.net', respostaAdd: { processed: ['553499911246'], failed: [] } });
    await worker.processarItem(item)

    expect(checkPhones).toHaveBeenCalled()
    expect(addGroupParticipant).toHaveBeenCalledTimes(1)
    // O endereço enviado é o do WhatsApp, não o do cadastro.
    // Com sufixo: `contactIds` repassa intacto. Sem sufixo, toWhapiRecipient voltaria a 13.
    expect(addGroupParticipant.mock.calls[0][1]).toEqual(['553499911246@s.whatsapp.net'])
    expect(finalizacao()).toMatchObject({ status: 'concluida', resultado: 'processed', erro_codigo: null })
  })

  test('antes da correção isto era WHATSAPP_RECUSOU: resposta ecoa o wa_id e conta como sucesso', async () => {
    // A Whapi responde com o endereço que ELA conhece; avaliar contra o número discado dava failed.
    montar({ waId: '553499911246@s.whatsapp.net', respostaAdd: { processed: ['553499911246@s.whatsapp.net'], failed: [] } })
    await worker.processarItem(item)
    expect(finalizacao()).toMatchObject({ resultado: 'processed' })
  })

  test('número sem WhatsApp falha com motivo próprio, sem chamar o add', async () => {
    montar({ waId: null, exists: false, respostaAdd: {} })
    await worker.processarItem(item)

    expect(addGroupParticipant).not.toHaveBeenCalled()
    expect(finalizacao()).toMatchObject({ status: 'falhou', erro_codigo: 'SEM_WHATSAPP' })
    expect(finalizacao().erro_mensagem).toMatch(/não tem WhatsApp/i)
  })

  test('endereço certo e ainda assim recusado: mensagem explica a privacidade e sugere o convite', async () => {
    montar({ waId: '553499911246@s.whatsapp.net', respostaAdd: { processed: [], failed: ['553499911246'] } })
    await worker.processarItem(item)

    expect(finalizacao()).toMatchObject({ status: 'falhou', erro_codigo: 'WHATSAPP_RECUSOU' })
    expect(finalizacao().erro_mensagem).toMatch(/privacidade/i)
    expect(finalizacao().erro_mensagem).toMatch(/convite/i)
  })

  test('checkPhones indisponível não bloqueia: adiciona com o número original', async () => {
    montar({ waId: '553499911246@s.whatsapp.net', respostaAdd: { processed: ['5534999911246'], failed: [] } })
    checkPhones.mockImplementation(async () => { throw new Error('timeout') })
    await worker.processarItem(item)

    expect(addGroupParticipant.mock.calls[0][1]).toEqual(['5534999911246'])
    expect(finalizacao()).toMatchObject({ resultado: 'processed' })
  })
})

describe('avaliarResultadoAdd — a Whapi ecoa o número com o 9º dígito', () => {
  let worker

  beforeEach(() => {
    jest.resetModules()
    const chain = {}
    const ret = () => chain
    chain.from = ret; chain.select = ret; chain.eq = ret; chain.update = ret
    chain.gte = () => Promise.resolve({ count: 0 })
    chain.in = () => Promise.resolve({ data: [], error: null })
    chain.maybeSingle = () => Promise.resolve({ data: { id: 'op1', status: 'em_execucao' }, error: null })
    chain.single = () => Promise.resolve({ data: {}, error: null })
    chain.rpc = jest.fn(async () => ({ data: true, error: null }))
    jest.doMock('../config/supabase', () => chain)
    jest.doMock('../services/providers', () => ({ getProvider: () => ({}) }))
    jest.doMock('../services/whatsappInstanceService', () => ({
      getWhatsappInstanceById: jest.fn(async () => ({ instance: { metadata: {} }, error: null })),
    }))
    jest.doMock('../services/comunidade/comunidadeFilaService', () => ({
      recalcularContadores: jest.fn(async () => ({})), pausarOperacaoAutomatica: jest.fn(async () => ({})),
    }))
    jest.doMock('../services/comunidade/comunidadeSocketService', () => ({ emitComunidade: jest.fn(), EVENTS: {} }))
    worker = require('../workers/comunidadeWorker')
  })

  afterEach(() => jest.resetModules())

  test('resposta REAL do canal: enviamos 12 dígitos, o failed volta com 13 → recusa', () => {
    // Capturado em 10/11/2026 no canal da empresa 4. Antes isto virava "1 ok" na tela,
    // com ninguém dentro do grupo: o failed não casava e caía no success:true.
    const data = { success: true, processed: [], failed: ['5534999911246@s.whatsapp.net'] }
    expect(worker.avaliarResultadoAdd('553499911246', data)).toBe('failed')
  })

  test('o inverso também casa: enviado com 13, ecoado com 12', () => {
    const data = { success: true, processed: [], failed: ['553499911246'] }
    expect(worker.avaliarResultadoAdd('5534999911246', data)).toBe('failed')
  })

  test('processed com a outra forma do número conta como entrou', () => {
    const data = { success: true, processed: ['5534999911246@s.whatsapp.net'], failed: [] }
    expect(worker.avaliarResultadoAdd('553499911246', data)).toBe('processed')
  })

  test('success:true com alguém em failed e ninguém em processed NÃO é sucesso', () => {
    const data = { success: true, processed: [], failed: ['5511999998888'] }
    expect(worker.avaliarResultadoAdd('553499911246', data)).toBe('failed')
  })

  test('sem arrays, success:true segue valendo (compatibilidade)', () => {
    expect(worker.avaliarResultadoAdd('553499911246', { success: true })).toBe('processed')
  })

  test('sem arrays e success:false é recusa', () => {
    expect(worker.avaliarResultadoAdd('553499911246', { success: false })).toBe('failed')
  })
})

describe('endereço enviado — o adapter reinsere o 9º dígito em número cru', () => {
  const { resolverEnderecoWhatsapp } = require('../services/chat/identity/enderecoWhatsappService')
  const { toWhapiRecipient } = require('../services/providers/whapi/phones')

  test('o adapter REALMENTE reinsere o 9º dígito (a razão de tudo)', () => {
    // Era isto que desfazia a resolução do wa_id: resolvíamos 12 dígitos e o adapter
    // devolvia 13, mandando a adição para um endereço que não existe no WhatsApp.
    expect(toWhapiRecipient('553499911246')).toBe('5534999911246')
  })

  test('verificado devolve chatId com sufixo — forma que o adapter repassa intacta', async () => {
    const provider = {
      checkPhones: async () => [{ input: '5534999911246', exists: true, waId: '553499911246@s.whatsapp.net' }],
    }
    const r = await resolverEnderecoWhatsapp(provider, '5534999911246', {})
    expect(r.chatId).toBe('553499911246@s.whatsapp.net')
    // E o sufixo é justamente o que faz `contactIds` NÃO passar por toWhapiRecipient.
    expect(r.chatId.toLowerCase()).toContain('@s.whatsapp.net')
  })

  test('NÃO verificado não inventa chatId (adapter ainda pode tentar as duas formas)', async () => {
    const provider = { checkPhones: async () => { throw new Error('fora do ar') } }
    const r = await resolverEnderecoWhatsapp(provider, '5534999911246', {})
    expect(r.chatId).toBe('')
    expect(r.jid).toBe('5534999911246')
  })

  test('número sem WhatsApp não ganha chatId', async () => {
    const provider = { checkPhones: async () => [{ input: '5534999999999', exists: false, waId: null }] }
    const r = await resolverEnderecoWhatsapp(provider, '5534999999999', {})
    expect(r.existe).toBe(false)
    expect(r.chatId).toBe('')
  })
})
