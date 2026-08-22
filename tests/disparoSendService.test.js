/**
 * Testes unitários — envio de item da fila (Etapa 7).
 * NUNCA chama UltraMSG real — mock completo.
 */

jest.mock('../services/providers/ultramsg', () => ({
  sendText: jest.fn(),
  sendImage: jest.fn(),
  sendVideo: jest.fn(),
  sendAudio: jest.fn(),
  sendFile: jest.fn(),
}))

jest.mock('../helpers/conversationSync', () => ({
  findOrCreateConversation: jest.fn(),
}))

jest.mock('../config/r2', () => ({
  empresaUsaR2: jest.fn(() => false),
  getPresignExpiresSeconds: jest.fn(() => 3600),
}))

jest.mock('../services/storage/r2Client', () => ({
  presignGetUrl: jest.fn(),
}))

const supabase = require('../config/supabase')
const ultramsg = require('../services/providers/ultramsg')
const { findOrCreateConversation } = require('../helpers/conversationSync')
const { enviarItemFila } = require('../services/disparoSendService')

function mockChain(result = { data: null, error: null }) {
  const chain = {}
  const methods = [
    'select', 'eq', 'neq', 'is', 'in', 'not', 'order', 'limit',
    'insert', 'update', 'upsert',
  ]
  for (const m of methods) chain[m] = jest.fn(() => chain)
  chain.single = jest.fn().mockResolvedValue(result)
  chain.maybeSingle = jest.fn().mockResolvedValue(result)
  chain.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject)
  return chain
}

const itemBase = {
  id: 100,
  company_id: 10,
  campanha_id: 1,
  execucao_id: 50,
  destinatario_id: 200,
  instancia_id: 5,
  variacao_id: 30,
}

const destinatario = {
  id: 200,
  nome: 'Fulano',
  telefone_normalizado: '5511999887766',
  telefone_original: '(11) 99988-7766',
  variaveis: {},
  cliente_id: null,
  status: 'ativo',
}

const variacao = {
  id: 30,
  tipo_mensagem: 'texto',
  texto: 'Olá {{nome}}',
  legenda: null,
  midia_storage_key: null,
  midia_url_disco: null,
  ativa: true,
}

const instancia = {
  id: 5,
  nome: 'Instância A',
  status: 'connected',
  ativo: true,
}

function mockContextoCompleto() {
  supabase.from.mockImplementation((table) => {
    switch (table) {
      case 'disparo_campanha_destinatarios':
        return mockChain({ data: destinatario, error: null })
      case 'disparo_campanha_variacoes':
        return mockChain({ data: variacao, error: null })
      case 'whatsapp_instances':
        return mockChain({ data: instancia, error: null })
      case 'disparo_campanhas':
        return mockChain({ data: { variacao_padrao_valores: {} }, error: null })
      case 'disparo_exclusoes':
        return mockChain({ data: null, error: null })
      default:
        return mockChain({ data: null, error: null })
    }
  })
}

describe('disparoSendService — dry-run e segurança', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockContextoCompleto()
  })

  it('dry-run: NUNCA chama ultramsg', async () => {
    const result = await enviarItemFila(itemBase, {
      dryRun: true,
      liveEnabled: false,
      allowlist: [],
    })

    expect(result.ok).toBe(true)
    expect(result.dryRun).toBe(true)
    expect(result.messageId).toMatch(/^dry-100$/)
    expect(ultramsg.sendText).not.toHaveBeenCalled()
    expect(ultramsg.sendImage).not.toHaveBeenCalled()
    expect(ultramsg.sendAudio).not.toHaveBeenCalled()
  })

  it('liveEnabled false força dry-run mesmo com dryRun=false', async () => {
    const result = await enviarItemFila(itemBase, {
      dryRun: false,
      liveEnabled: false,
      allowlist: [],
    })

    expect(result.ok).toBe(true)
    expect(result.dryRun).toBe(true)
    expect(ultramsg.sendText).not.toHaveBeenCalled()
  })

  it('allowlist bloqueia telefone fora da lista', async () => {
    const result = await enviarItemFila(itemBase, {
      dryRun: true,
      liveEnabled: false,
      allowlist: ['34999887766'],
    })

    expect(result.ok).toBe(false)
    expect(result.errorCodigo).toBe('ALLOWLIST')
    expect(result.httpStatus).toBe(403)
    expect(ultramsg.sendText).not.toHaveBeenCalled()
  })

  it('allowlist vazia permite qualquer telefone em dry-run', async () => {
    const result = await enviarItemFila(itemBase, {
      dryRun: true,
      allowlist: [],
    })
    expect(result.ok).toBe(true)
  })

  it('exclusão ativa bloqueia envio', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'disparo_exclusoes') {
        return mockChain({ data: { id: 1 }, error: null })
      }
      if (table === 'disparo_campanha_destinatarios') {
        return mockChain({ data: destinatario, error: null })
      }
      if (table === 'disparo_campanha_variacoes') {
        return mockChain({ data: variacao, error: null })
      }
      if (table === 'whatsapp_instances') {
        return mockChain({ data: instancia, error: null })
      }
      if (table === 'disparo_campanhas') {
        return mockChain({ data: { variacao_padrao_valores: {} }, error: null })
      }
      return mockChain({ data: null, error: null })
    })

    const result = await enviarItemFila(itemBase, { dryRun: true, allowlist: [] })
    expect(result.ok).toBe(false)
    expect(result.errorCodigo).toBe('EXCLUIDO')
    expect(ultramsg.sendText).not.toHaveBeenCalled()
  })

  it('instância desconectada retorna erro antes do envio', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'whatsapp_instances') {
        return mockChain({ data: { ...instancia, status: 'disconnected' }, error: null })
      }
      if (table === 'disparo_campanha_destinatarios') {
        return mockChain({ data: destinatario, error: null })
      }
      if (table === 'disparo_campanha_variacoes') {
        return mockChain({ data: variacao, error: null })
      }
      if (table === 'disparo_campanhas') {
        return mockChain({ data: { variacao_padrao_valores: {} }, error: null })
      }
      if (table === 'disparo_exclusoes') {
        return mockChain({ data: null, error: null })
      }
      return mockChain({ data: null, error: null })
    })

    const result = await enviarItemFila(itemBase, { dryRun: false, liveEnabled: true, allowlist: [] })
    expect(result.ok).toBe(false)
    expect(result.httpStatus).toBe(409)
    expect(ultramsg.sendText).not.toHaveBeenCalled()
  })
})

describe('disparoSendService — live (mock ultramsg)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockContextoCompleto()
    findOrCreateConversation.mockResolvedValue({
      conversa: { id: 999 },
    })
    supabase.from.mockImplementation((table) => {
      if (table === 'mensagens') {
        return mockChain({ data: { id: 888 }, error: null })
      }
      if (table === 'disparo_fila_itens') {
        return mockChain({ data: null, error: null })
      }
      if (table === 'disparo_campanha_destinatarios') {
        return mockChain({ data: destinatario, error: null })
      }
      if (table === 'disparo_campanha_variacoes') {
        return mockChain({ data: variacao, error: null })
      }
      if (table === 'whatsapp_instances') {
        return mockChain({ data: instancia, error: null })
      }
      if (table === 'disparo_campanhas') {
        return mockChain({ data: { variacao_padrao_valores: {} }, error: null })
      }
      if (table === 'disparo_exclusoes') {
        return mockChain({ data: null, error: null })
      }
      return mockChain({ data: null, error: null })
    })
  })

  it('live chama ultramsg.sendText e persiste mensagem', async () => {
    ultramsg.sendText.mockResolvedValue({ ok: true, messageId: 'wamid-abc' })

    const result = await enviarItemFila(itemBase, {
      dryRun: false,
      liveEnabled: true,
      allowlist: [],
      timeoutMs: 5000,
    })

    expect(result.ok).toBe(true)
    expect(result.dryRun).toBe(false)
    expect(result.messageId).toBe('wamid-abc')
    expect(ultramsg.sendText).toHaveBeenCalledWith(
      '5511999887766',
      expect.any(String),
      expect.objectContaining({
        companyId: 10,
        referenceId: 'disp-100',
      }),
    )
  })

  it('falha do provedor retorna erro sem exceção', async () => {
    ultramsg.sendText.mockResolvedValue({
      ok: false,
      error: 'Provider rejected',
      httpStatus: 502,
    })

    const result = await enviarItemFila(itemBase, {
      dryRun: false,
      liveEnabled: true,
      allowlist: [],
    })

    expect(result.ok).toBe(false)
    expect(result.httpStatus).toBe(502)
  })
})
