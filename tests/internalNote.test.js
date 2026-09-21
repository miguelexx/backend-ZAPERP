const {
  INTERNAL_NOTE_MAX_LEN,
  assertNotInternalNote,
  buildInternalNoteInsert,
  isInternalNoteRow,
  sanitizeInternalNoteTexto,
} = require('../helpers/internalNote')
const {
  enrichMensagemComAutorUsuario,
  enrichMensagensComAutorUsuario,
} = require('../services/chat/presentation/messageAuthorEnrichment')

describe('notas internas', () => {
  test('sanitiza texto e monta uma linha que nunca se confunde com mensagem WhatsApp', () => {
    expect(sanitizeInternalNoteTexto('  teste\u0000 interno  ')).toBe('teste interno')
    expect(() => sanitizeInternalNoteTexto('   ')).toThrow('não pode ser vazio')
    expect(() => sanitizeInternalNoteTexto('x'.repeat(INTERNAL_NOTE_MAX_LEN + 1))).toThrow('limitada')

    const row = buildInternalNoteInsert({
      company_id: '7',
      conversa_id: '11',
      autor_usuario_id: '23',
      texto: 'Somente equipe',
    })
    expect(row).toEqual({
      company_id: 7,
      conversa_id: 11,
      autor_usuario_id: 23,
      texto: 'Somente equipe',
      tipo: 'internal_note',
      direcao: 'interna',
    })
    expect(isInternalNoteRow(row)).toBe(true)
    expect(() => assertNotInternalNote(row, 'teste')).toThrow('INTERNAL_NOTE_BLOCKED')
  })

  test('mantém o nome do autor ao recarregar uma nota do histórico', async () => {
    const query = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      in: jest.fn().mockResolvedValue({ data: [{ id: 23, nome: 'Nicolas' }], error: null }),
    }
    const fakeSupabase = { from: jest.fn(() => query) }
    const [nota] = await enrichMensagensComAutorUsuario(fakeSupabase, 7, [{
      id: 91,
      company_id: 7,
      conversa_id: 11,
      autor_usuario_id: 23,
      texto: 'Somente equipe',
      tipo: 'internal_note',
      direcao: 'interna',
      criado_em: '2026-09-21T14:23:00',
    }])

    expect(nota.usuario_id).toBe(23)
    expect(nota.usuario_nome).toBe('Nicolas')
    expect(nota.enviado_por_usuario).toBe(false)
  })

  test('mantém autoria sem classificar nota como mensagem outbound', async () => {
    const query = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: { id: 23, nome: 'Nicolas' }, error: null }),
    }
    const fakeSupabase = { from: jest.fn(() => query) }
    const nota = await enrichMensagemComAutorUsuario(fakeSupabase, 7, {
      id: 92,
      autor_usuario_id: 23,
      tipo: 'internal_note',
      direcao: 'interna',
      texto: 'Editada localmente',
    })

    expect(nota.usuario_nome).toBe('Nicolas')
    expect(nota.enviado_por_usuario).toBe(false)
    expect(nota.fromMe).toBe(false)
  })
})
