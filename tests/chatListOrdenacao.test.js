const {
  sortConversationsByRecent,
  sortConversationsPinThenRecent,
  conversationHasMensagem,
} = require('../helpers/conversationSync')

const ids = (list) => list.map((c) => c.id)

describe('ordenacao da lista de conversas', () => {
  test('conversa sem nenhuma mensagem nao ocupa o topo de "Todas"', () => {
    // Conversa criada hoje ao abrir um contato: ultima_atividade = agora, zero mensagens.
    const semMensagem = {
      id: 1,
      mensagens: [],
      ultima_atividade: '2026-07-28T12:00:00.000Z',
      criado_em: '2026-07-28T12:00:00.000Z',
    }
    // Conversa real, com mensagem mais antiga que a criacao da linha vazia.
    const comMensagem = {
      id: 2,
      mensagens: [{ id: 9, criado_em: '2026-07-27T18:00:00.000Z' }],
      ultima_mensagem: { id: 9, criado_em: '2026-07-27T18:00:00.000Z' },
      ultima_atividade: '2026-07-27T18:00:00.000Z',
      criado_em: '2026-07-01T09:00:00.000Z',
    }

    expect(ids(sortConversationsByRecent([semMensagem, comMensagem]))).toEqual([2, 1])
    expect(ids(sortConversationsByRecent([comMensagem, semMensagem]))).toEqual([2, 1])
  })

  test('entre conversas com mensagem, segue a recencia normal', () => {
    const antiga = {
      id: 1,
      ultima_mensagem: { criado_em: '2026-07-20T10:00:00.000Z' },
      ultima_atividade: '2026-07-20T10:00:00.000Z',
    }
    const recente = {
      id: 2,
      ultima_mensagem: { criado_em: '2026-07-28T10:00:00.000Z' },
      ultima_atividade: '2026-07-28T10:00:00.000Z',
    }
    expect(ids(sortConversationsByRecent([antiga, recente]))).toEqual([2, 1])
  })

  test('entre conversas sem mensagem, mantem a mais recente primeiro', () => {
    const a = { id: 1, mensagens: [], ultima_atividade: '2026-07-28T09:00:00.000Z' }
    const b = { id: 2, mensagens: [], ultima_atividade: '2026-07-28T11:00:00.000Z' }
    expect(ids(sortConversationsByRecent([a, b]))).toEqual([2, 1])
  })

  test('fixada continua no topo mesmo sem mensagem', () => {
    const fixadaSemMensagem = {
      id: 1,
      fixada: true,
      mensagens: [],
      ultima_atividade: '2026-07-01T09:00:00.000Z',
    }
    const comMensagem = {
      id: 2,
      ultima_mensagem: { criado_em: '2026-07-28T10:00:00.000Z' },
      ultima_atividade: '2026-07-28T10:00:00.000Z',
    }
    const semMensagem = { id: 3, mensagens: [], ultima_atividade: '2026-07-28T12:00:00.000Z' }

    expect(ids(sortConversationsPinThenRecent([semMensagem, comMensagem, fixadaSemMensagem]))).toEqual([1, 2, 3])
  })

  test('conversationHasMensagem cobre as fontes de preview da listagem', () => {
    expect(conversationHasMensagem({ mensagens: [{ id: 1 }] })).toBe(true)
    expect(conversationHasMensagem({ ultima_mensagem: { criado_em: '2026-07-28T10:00:00.000Z' } })).toBe(true)
    expect(conversationHasMensagem({ ultima_mensagem_preview: { criado_em: '2026-07-28T10:00:00.000Z' } })).toBe(true)
    expect(conversationHasMensagem({ mensagens: [] })).toBe(false)
    expect(conversationHasMensagem({ sem_conversa: true, mensagens: [{ id: 1 }] })).toBe(false)
    expect(conversationHasMensagem(null)).toBe(false)
  })
})
