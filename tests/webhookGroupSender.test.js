/**
 * Contrato de resolveGroupSenderFields (controllers/webhookInbound/groupSender.js), extraído do miolo
 * de receberZapi na Fase 5 (doc 24). Trava o comportamento observável — os campos `remetente_*` que
 * vão para a linha da mensagem do grupo — que antes não tinha teste algum.
 */

process.env.ZAPERP_DISABLE_BACKGROUND_JOBS = '1'

// Telefone: normalização determinística para asserção estável (não depende das regras BR reais).
jest.mock('../helpers/phoneHelper', () => ({
  ...jest.requireActual('../helpers/phoneHelper'),
  normalizePhoneBR: jest.fn((p) => String(p || '').replace(/\D/g, '')),
  possiblePhonesBR: jest.fn(() => []),
}))
// Sem cliente pré-existente no cadastro → cai no getOrCreateCliente; retornamos null p/ pular o sync bg.
jest.mock('../helpers/conversationSync', () => ({
  ...jest.requireActual('../helpers/conversationSync'),
  getOrCreateCliente: jest.fn().mockResolvedValue({ cliente_id: null }),
}))

const { getOrCreateCliente } = require('../helpers/conversationSync')
const { resolveGroupSenderFields } = require('../controllers/webhookInbound/groupSender')

describe('resolveGroupSenderFields — remetente do grupo (caracterização)', () => {
  beforeEach(() => jest.clearAllMocks())

  test('com telefone do participante + senderName → grava telefone normalizado e nome', async () => {
    const out = await resolveGroupSenderFields({
      companyId: 1,
      participantPhone: '55 (34) 99999-9999',
      senderName: 'Fulano',
    })
    expect(out.remetente_telefone).toBe('5534999999999')
    // Sem cliente no cadastro (mock global não retorna linha na lista) → mantém o senderName.
    expect(out.remetente_nome).toBe('Fulano')
  })

  test('sem telefone do participante → não grava remetente_telefone, mas mantém o nome se houver', async () => {
    const out = await resolveGroupSenderFields({ companyId: 1, participantPhone: '', senderName: 'Ciclano' })
    expect(out.remetente_telefone).toBeUndefined()
    expect(out.remetente_nome).toBe('Ciclano')
    // Sem telefone não há lookup nem criação de contato.
    expect(getOrCreateCliente).not.toHaveBeenCalled()
  })

  test('sem telefone e sem nome → objeto vazio (nada a gravar)', async () => {
    const out = await resolveGroupSenderFields({ companyId: 1, participantPhone: '', senderName: '' })
    expect(out).toEqual({})
  })
})
