/**
 * Contrato de enrichReplyMetaSnippets (services/chat/presentation/replyMetaSnippetEnrichment.js).
 * Garante que a citação genérica ("Mensagem"/vazia) é resolvida com o texto real da mensagem citada,
 * pela página em memória (custo zero) ou por consulta única, sem tocar citações especiais/boas.
 */

jest.mock('../controllers/webhookInbound/whatsappIdLookup', () => ({
  ...jest.requireActual('../controllers/webhookInbound/whatsappIdLookup'),
  applyWhatsappInstanceFilterOrLegacy: jest.fn((q) => q),
}))

const {
  enrichReplyMetaSnippets,
  replyMetaNeedsSnippet,
  snippetFromQuotedRow,
} = require('../services/chat/presentation/replyMetaSnippetEnrichment')

/** Fake supabase: só o caminho `.from().select().eq().eq().in()` importa (retorna `rows`). */
function fakeSupabase(rows) {
  const q = {
    from: () => q,
    select: () => q,
    eq: () => q,
    is: () => q,
    in: () => Promise.resolve({ data: rows, error: null }),
  }
  return q
}

const base = { company_id: 1, conversa_id: 10, whatsapp_instance_id: 5 }

describe('replyMetaNeedsSnippet', () => {
  test('true só para citação genérica/vazia com replyToId', () => {
    expect(replyMetaNeedsSnippet({ replyToId: 'A', snippet: 'Mensagem' })).toBe(true)
    expect(replyMetaNeedsSnippet({ replyToId: 'A', snippet: '' })).toBe(true)
    expect(replyMetaNeedsSnippet({ replyToId: 'A', snippet: 'olá tudo bem?' })).toBe(false)
    expect(replyMetaNeedsSnippet({ snippet: 'Mensagem' })).toBe(false) // sem replyToId
    expect(replyMetaNeedsSnippet({ replyToId: 'A', snippet: 'Mensagem', poll: {} })).toBe(false)
    expect(replyMetaNeedsSnippet(null)).toBe(false)
  })
})

describe('snippetFromQuotedRow', () => {
  test('texto real e rótulos por tipo de mídia', () => {
    expect(snippetFromQuotedRow({ tipo: 'texto', texto: 'combinado 2.00' })).toBe('combinado 2.00')
    expect(snippetFromQuotedRow({ tipo: 'audio' })).toBe('(áudio)')
    expect(snippetFromQuotedRow({ tipo: 'imagem' })).toBe('Foto')
    expect(snippetFromQuotedRow({ tipo: 'imagem', texto: 'IMG-0001.jpg' })).toBe('Foto') // nome de arquivo não vira preview
    expect(snippetFromQuotedRow({ tipo: 'imagem', texto: 'olha o produto' })).toBe('olha o produto')
    expect(snippetFromQuotedRow({ tipo: 'sticker' })).toBe('Figurinha')
    expect(snippetFromQuotedRow({ tipo: 'arquivo', nome_arquivo: 'nota.pdf' })).toBe('nota.pdf')
    expect(snippetFromQuotedRow({ tipo: 'texto', texto: '' })).toBeNull()
  })
})

describe('enrichReplyMetaSnippets', () => {
  test('resolve pela página em memória, sem consultar o banco', async () => {
    const supa = fakeSupabase(null)
    const inSpy = jest.spyOn(supa, 'in')
    const mensagens = [
      { id: 1, whatsapp_id: 'WA-QUOTED', texto: 'quero 5 unidades', tipo: 'texto', direcao: 'in', remetente_nome: 'Lázaro' },
      { id: 2, whatsapp_id: 'WA-REPLY', texto: '2.00', tipo: 'texto', reply_meta: { name: 'Contato', snippet: 'Mensagem', replyToId: 'WA-QUOTED' } },
    ]
    const out = await enrichReplyMetaSnippets(supa, base, mensagens)
    expect(out[1].reply_meta.snippet).toBe('quero 5 unidades')
    expect(out[1].reply_meta.name).toBe('Lázaro')
    expect(out[0]).toBe(mensagens[0]) // linha sem citação intocada (mesma referência)
    expect(inSpy).not.toHaveBeenCalled()
  })

  test('resolve por consulta quando a citada não está na página', async () => {
    const supa = fakeSupabase([
      { whatsapp_id: 'WA-OLD', texto: 'segue a tabela de preços', tipo: 'texto', direcao: 'out', remetente_nome: null },
    ])
    const mensagens = [
      { id: 9, whatsapp_id: 'WA-REPLY', texto: '4.50', tipo: 'texto', reply_meta: { name: 'Contato', snippet: '', replyToId: 'WA-OLD' } },
    ]
    const out = await enrichReplyMetaSnippets(supa, base, mensagens)
    expect(out[0].reply_meta.snippet).toBe('segue a tabela de preços')
    expect(out[0].reply_meta.name).toBe('Você')
  })

  test('não sobrescreve snippet já preenchido nem citação especial (poll)', async () => {
    const mensagens = [
      { id: 1, texto: 'x', reply_meta: { snippet: 'texto bom', replyToId: 'A' } },
      { id: 2, texto: 'y', reply_meta: { snippet: 'Mensagem', poll: { question: 'Q' } } },
    ]
    const out = await enrichReplyMetaSnippets(fakeSupabase(null), base, mensagens)
    expect(out).toBe(mensagens) // nada mudou → mesma referência
  })

  test('citada inexistente (nem página nem banco) → mantém a mensagem', async () => {
    const mensagens = [
      { id: 3, texto: '3.00', reply_meta: { name: 'Contato', snippet: 'Mensagem', replyToId: 'SUMIU' } },
    ]
    const out = await enrichReplyMetaSnippets(fakeSupabase([]), base, mensagens)
    expect(out[0].reply_meta.snippet).toBe('Mensagem')
  })
})
