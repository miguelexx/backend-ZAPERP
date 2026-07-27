/**
 * Rajada de áudios recebidos: o 2º/3º chegam dentro da janela de debounce e antes esperavam o
 * FIM dela (até 60s) para a passada de arrasto reparar a mídia — ou seja, o atendente não
 * conseguia ouvir na hora. A passada agora é limitada a poucos segundos, continuando coalescida
 * numa única chamada ao provedor.
 */
const mockSync = jest.fn(async () => ({ messagesUpdated: 1, messagesInserted: 0 }))
jest.mock('../services/oldMessagesSyncService', () => ({
  syncOldMessagesForConversation: (...args) => mockSync(...args),
}))

const { scheduleInboundMediaBackfill } = require('../services/inboundMediaBackfillService')

const audioSemUrl = { tipo: 'voice', texto: '(áudio)', url: null }
const ctxBase = { supabase: {}, io: null, company_id: 1 }

/** Cada teste usa uma conversa nova: o debounce do serviço é um mapa module-level. */
let proximaConversa = 9000

beforeEach(() => {
  mockSync.mockClear()
  jest.useFakeTimers()
})

afterEach(() => {
  jest.runOnlyPendingTimers()
  jest.useRealTimers()
})

async function drenar() {
  jest.runOnlyPendingTimers()
  await Promise.resolve()
  await Promise.resolve()
}

test('primeiro áudio dispara o reparo de imediato', async () => {
  const conversa_id = proximaConversa++
  scheduleInboundMediaBackfill({ ...ctxBase, conversa_id, mensagemSalva: audioSemUrl })
  await drenar()
  expect(mockSync).toHaveBeenCalledTimes(1)
})

test('2º áudio da rajada é reparado em segundos, não ao fim do debounce', async () => {
  const conversa_id = proximaConversa++
  scheduleInboundMediaBackfill({ ...ctxBase, conversa_id, mensagemSalva: audioSemUrl })
  await drenar()
  expect(mockSync).toHaveBeenCalledTimes(1)

  // Chega o 2º áudio dentro da janela de debounce (60s).
  scheduleInboundMediaBackfill({ ...ctxBase, conversa_id, mensagemSalva: audioSemUrl })

  // Teto da passada de arrasto: 8s por padrão. Bem antes do fim da janela de debounce.
  jest.advanceTimersByTime(8_000)
  await drenar()
  expect(mockSync).toHaveBeenCalledTimes(2)
})

test('vários áudios na mesma rajada continuam coalescidos numa única passada', async () => {
  const conversa_id = proximaConversa++
  scheduleInboundMediaBackfill({ ...ctxBase, conversa_id, mensagemSalva: audioSemUrl })
  await drenar()
  expect(mockSync).toHaveBeenCalledTimes(1)

  for (let i = 0; i < 5; i++) {
    scheduleInboundMediaBackfill({ ...ctxBase, conversa_id, mensagemSalva: audioSemUrl })
  }
  jest.advanceTimersByTime(8_000)
  await drenar()
  // 1 disparo inicial + 1 passada de arrasto para os 5 seguintes (não 6).
  expect(mockSync).toHaveBeenCalledTimes(2)
})

test('mensagem que já tem URL não agenda nada', async () => {
  const conversa_id = proximaConversa++
  scheduleInboundMediaBackfill({
    ...ctxBase,
    conversa_id,
    mensagemSalva: { tipo: 'voice', url: '/uploads/a.ogg' },
  })
  await drenar()
  expect(mockSync).not.toHaveBeenCalled()
})
