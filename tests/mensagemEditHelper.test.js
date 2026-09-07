const {
  EDIT_WINDOW_MS,
  isTextEditTipo,
  isMediaCaptionTipo,
  isEditableMessageTipo,
  pickEditTextoFromBody,
  normalizeEditTexto,
  isEditWindowOpen,
  remainingEditWindowMs,
  buildEditadaDbUpdates,
  isMissingEditadaColumnError,
  aplicarCamposEdicaoNaMensagem,
  buildMensagemEditadaSocketPayload,
} = require('../helpers/mensagemEditHelper')

describe('mensagemEditHelper', () => {
  test('tipos: texto e mídia com caption; áudio/sticker não', () => {
    expect(isTextEditTipo('texto')).toBe(true)
    expect(isMediaCaptionTipo('imagem')).toBe(true)
    expect(isMediaCaptionTipo('video')).toBe(true)
    expect(isMediaCaptionTipo('arquivo')).toBe(true)
    expect(isEditableMessageTipo('voice')).toBe(false)
    expect(isEditableMessageTipo('sticker')).toBe(false)
    expect(isEditableMessageTipo('location')).toBe(false)
  })

  test('pickEditTextoFromBody aceita aliases e detecta ausência', () => {
    expect(pickEditTextoFromBody({ texto: 'oi' })).toEqual({ present: true, raw: 'oi' })
    expect(pickEditTextoFromBody({ caption: 'leg' })).toEqual({ present: true, raw: 'leg' })
    expect(pickEditTextoFromBody({})).toEqual({ present: false, raw: '' })
  })

  test('normalizeEditTexto: texto vazio falha; caption vazia ok', () => {
    expect(normalizeEditTexto('  ', 'texto').ok).toBe(false)
    expect(normalizeEditTexto('  ', 'imagem')).toEqual({ ok: true, texto: '' })
    expect(normalizeEditTexto('ok', 'texto')).toEqual({ ok: true, texto: 'ok' })
    expect(normalizeEditTexto('x', 'audio').code).toBe('EDIT_TYPE_UNSUPPORTED')
  })

  test('janela de 15 minutos', () => {
    const now = Date.parse('2026-09-07T20:00:00.000Z')
    expect(isEditWindowOpen('2026-09-07T19:50:00.000Z', now)).toBe(true)
    expect(isEditWindowOpen('2026-09-07T19:40:00.000Z', now)).toBe(false)
    expect(remainingEditWindowMs('2026-09-07T19:50:00.000Z', now)).toBe(5 * 60 * 1000)
    expect(EDIT_WINDOW_MS).toBe(15 * 60 * 1000)
  })

  test('flags de API e payload de socket', () => {
    expect(aplicarCamposEdicaoNaMensagem({ id: 1, editada: true, editada_em: 't' })).toMatchObject({
      editada: true, editado: true, editada_em: 't',
    })
    expect(aplicarCamposEdicaoNaMensagem({ id: 1 })).toMatchObject({ editada: false, editado: false })
    const updates = buildEditadaDbUpdates('novo', new Date('2026-09-07T20:00:00.000Z'))
    expect(updates).toEqual({ texto: 'novo', editada: true, editada_em: '2026-09-07T20:00:00.000Z' })
    expect(isMissingEditadaColumnError({ message: 'column "editada" does not exist' })).toBe(true)
    expect(buildMensagemEditadaSocketPayload({
      id: 9, conversa_id: 3, company_id: 1, texto: 'x', editada_em: 't',
    })).toMatchObject({
      id: 9, conversa_id: 3, company_id: 1, texto: 'x', conteudo: 'x', editada: true, editado: true,
    })
  })
})
