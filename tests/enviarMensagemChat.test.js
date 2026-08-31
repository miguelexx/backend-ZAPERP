/**
 * Teste de caracterização de enviarMensagemChat (fachada chatController).
 *
 * Congela os contratos determinísticos de ENTRADA do handler — validação e as duas vias de
 * deduplicação por client_temp_id + permissão negada — que retornam ANTES do envio ao provider.
 * Serve de rede de segurança para a futura extração do pipeline de saída (Fase 6): esses caminhos
 * não podem regredir. O mapeamento de status do provider já é coberto por envioManualMensagem.test.js
 * e chatProviderResultMapper.test.js.
 *
 * Usa o mock global de supabase (tests/setup.js) e mocka provider/policy para isolar o handler.
 */

const mockProvider = { sendText: jest.fn().mockResolvedValue({ ok: true, messageId: 'BAE543FE1CE17AFA' }) }
jest.mock('../services/providers', () => ({ getProvider: () => mockProvider }))
jest.mock('../services/chat/access/conversationPolicy', () => ({
  assertPermissaoConversa: jest.fn(),
  podeAssumirConversaPorPerfil: jest.fn(),
  assertPodeEnviarMensagem: jest.fn(),
}))
jest.mock('../helpers/empresaModoSimplesFlag', () => ({ empresaModoSimplesAtivo: jest.fn().mockResolvedValue(false) }))
jest.mock('../services/absenceFinalizationService', () => ({
  ...jest.requireActual('../services/absenceFinalizationService'),
  tryMarkWaitingAfterHumanOutbound: jest.fn().mockResolvedValue(null),
}))
jest.mock('../services/chat/outbound/modoSimplesOutbound', () => ({
  ...jest.requireActual('../services/chat/outbound/modoSimplesOutbound'),
  recalcularEMesclarModoSimples: jest.fn().mockResolvedValue(null),
}))

const supabase = require('../config/supabase')
const { assertPodeEnviarMensagem } = require('../services/chat/access/conversationPolicy')
const { deduplicationMap } = require('../services/chat/outbound/idempotencyService')
const { clientTempIdDedupeKey } = require('../services/chat/outbound/idempotencyHelpers')
const { enviarMensagemChat } = require('../controllers/chatController')

function buildRes() {
  const res = {}
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  res.set = jest.fn().mockReturnValue(res)
  return res
}
function buildReq(overrides = {}) {
  return {
    user: { company_id: 1, id: 2, perfil: 'atendente', departamento_ids: [] },
    params: { id: 10 },
    body: { texto: 'olá' },
    app: { get: () => undefined },
    ...overrides,
  }
}

describe('enviarMensagemChat — contratos de entrada (caracterização)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    deduplicationMap.clear()
    // default: permissão liberada (para os testes que precisam passar da política)
    assertPodeEnviarMensagem.mockResolvedValue({ ok: true })
  })

  test('texto ausente/vazio → 400 e NÃO envia', async () => {
    const res = buildRes()
    await enviarMensagemChat(buildReq({ body: { texto: '   ' } }), res)
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'texto é obrigatório' })
    expect(mockProvider.sendText).not.toHaveBeenCalled()
  })

  test('dedup em memória (client_temp_id recente) → resposta deduplicated, sem enviar nem consultar política', async () => {
    const key = clientTempIdDedupeKey(1, 10, 'ct-abc')
    deduplicationMap.set(key, { id: 999, status: 'sent', ts: Date.now() })

    const res = buildRes()
    await enviarMensagemChat(buildReq({ body: { texto: 'oi', client_temp_id: 'ct-abc' } }), res)

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      id: 999,
      conversa_id: 10,
      client_temp_id: 'ct-abc',
      status: 'sent',
      deduplicated: true,
    }))
    expect(mockProvider.sendText).not.toHaveBeenCalled()
    expect(assertPodeEnviarMensagem).not.toHaveBeenCalled()
  })

  test('dedup persistente (linha existente no banco) → resposta deduplicated, sem enviar', async () => {
    const chain = supabase.from()
    // findMensagemByClientTempId → encontra a linha persistida.
    chain.maybeSingle.mockResolvedValueOnce({
      data: { id: 555, conversa_id: 10, status: 'pending', client_temp_id: 'ct-xyz' },
      error: null,
    })

    const res = buildRes()
    await enviarMensagemChat(buildReq({ body: { texto: 'oi', client_temp_id: 'ct-xyz' } }), res)

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      id: 555,
      conversa_id: 10,
      client_temp_id: 'ct-xyz',
      deduplicated: true,
    }))
    expect(mockProvider.sendText).not.toHaveBeenCalled()
    // Também cacheia em memória para próximos double-clicks.
    expect(deduplicationMap.get(clientTempIdDedupeKey(1, 10, 'ct-xyz'))).toMatchObject({ id: 555 })
  })

  test('permissão negada → repassa status/erro da política e NÃO envia', async () => {
    assertPodeEnviarMensagem.mockResolvedValueOnce({ ok: false, status: 403, error: 'Assuma a conversa antes de enviar mensagens' })

    const res = buildRes()
    // sem client_temp_id: pula ambas as vias de dedup e chega na política.
    await enviarMensagemChat(buildReq({ body: { texto: 'oi' } }), res)

    expect(assertPodeEnviarMensagem).toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'Assuma a conversa antes de enviar mensagens' })
    expect(mockProvider.sendText).not.toHaveBeenCalled()
  })
})

describe('enviarMensagemChat — caminho de envio (caracterização)', () => {
  // conversa (1ª chamada de .single()) e mensagem inserida (2ª chamada de .single()).
  const conversaRow = {
    id: 10, telefone: '5534999999999', cliente_id: 7, tipo: 'cliente',
    nome_contato_cache: null, foto_perfil_contato_cache: null, chat_lid: null, whatsapp_instance_id: 1,
  }
  const msgRow = { id: 42, conversa_id: 10, criado_em: '2026-08-31T12:00:00.000Z', texto: 'oi', direcao: 'out', status: 'pending' }

  function primeSupabaseSingles(chain) {
    // resolveConversationWhatsappInstance não consulta (instance_id já > 0).
    chain.single
      .mockResolvedValueOnce({ data: conversaRow, error: null }) // SELECT conversa
      .mockResolvedValueOnce({ data: msgRow, error: null })      // INSERT mensagens
  }

  let chain
  beforeEach(() => {
    jest.clearAllMocks()
    deduplicationMap.clear()
    assertPodeEnviarMensagem.mockResolvedValue({ ok: true })
    chain = supabase.from()
  })

  test('provider aceita com ID rastreável → responde status=sent + whatsapp_id, envia 1x', async () => {
    primeSupabaseSingles(chain)
    mockProvider.sendText.mockResolvedValueOnce({ ok: true, messageId: 'BAE543FE1CE17AFA' })

    const res = buildRes()
    await enviarMensagemChat(buildReq({ body: { texto: 'oi' } }), res)

    expect(mockProvider.sendText).toHaveBeenCalledTimes(1)
    expect(mockProvider.sendText.mock.calls[0][0]).toBe('5534999999999')
    expect(res.json).toHaveBeenCalledWith({
      ok: true, id: 42, conversa_id: 10, status: 'sent', whatsapp_id: 'BAE543FE1CE17AFA',
    })
  })

  test('provider aceita SEM ID rastreável (ID de fila) → status=pending, sem whatsapp_id', async () => {
    primeSupabaseSingles(chain)
    mockProvider.sendText.mockResolvedValueOnce({ ok: true, messageId: '35096' })

    const res = buildRes()
    await enviarMensagemChat(buildReq({ body: { texto: 'oi' } }), res)

    expect(res.json).toHaveBeenCalledWith({ ok: true, id: 42, conversa_id: 10, status: 'pending' })
  })

  test('provider recusa → status=erro + motivo, mensagem persistida id=42', async () => {
    primeSupabaseSingles(chain)
    mockProvider.sendText.mockResolvedValueOnce({ ok: false, error: 'Instância desconectada' })

    const res = buildRes()
    await enviarMensagemChat(buildReq({ body: { texto: 'oi' } }), res)

    expect(res.json).toHaveBeenCalledWith({ ok: true, id: 42, conversa_id: 10, status: 'erro', motivo: 'Instância desconectada' })
  })
})
