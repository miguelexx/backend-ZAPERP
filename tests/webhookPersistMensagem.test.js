/**
 * Contrato de applyInboundMediaFields (controllers/webhookInbound/persistMensagem.js) — o mapeamento
 * puro `type/mídia → campos do row` extraído do miolo de receberZapi (Fase 5, doc 24). Trava cada ramo
 * de tipo, que antes não tinha teste direto.
 */

const { applyInboundMediaFields } = require('../controllers/webhookInbound/persistMensagem')

const base = () => ({ conversa_id: 10, texto: 'x', direcao: 'in', company_id: 1 })

describe('applyInboundMediaFields — tipo/mídia → campos do insert (caracterização)', () => {
  test('imagem: tipo/url/nome_arquivo (default imagem.jpg)', () => {
    const m = applyInboundMediaFields(base(), { type: 'image', imageUrl: 'https://x/i.jpg' })
    expect(m).toMatchObject({ tipo: 'imagem', url: 'https://x/i.jpg', nome_arquivo: 'imagem.jpg' })
  })

  test('document/file: tipo arquivo; usa fileName quando presente', () => {
    const m = applyInboundMediaFields(base(), { type: 'document', documentUrl: 'https://x/d.pdf', fileName: 'nota.pdf' })
    expect(m).toMatchObject({ tipo: 'arquivo', url: 'https://x/d.pdf', nome_arquivo: 'nota.pdf' })
  })

  test('ptt: tipo voice + nome_arquivo default voice.ogg', () => {
    const m = applyInboundMediaFields(base(), { type: 'ptt', audioUrl: 'https://x/a.ogg' })
    expect(m).toMatchObject({ tipo: 'voice', url: 'https://x/a.ogg', nome_arquivo: 'voice.ogg' })
  })

  test('audio sem URL: seta tipo audio mas NÃO url, e emite warn diagnóstico', () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const m = applyInboundMediaFields(base(), { type: 'audio', diag: { company_id: 1, conversa_id: 10, fromMe: false } })
    expect(m.tipo).toBe('audio')
    expect(m.url).toBeUndefined()
    expect(spy).toHaveBeenCalledWith('[webhook] áudio inbound sem URL de mídia:', expect.objectContaining({ type: 'audio', hasImageUrl: false }))
    spy.mockRestore()
  })

  test('video e sticker', () => {
    expect(applyInboundMediaFields(base(), { type: 'video', videoUrl: 'https://x/v.mp4' })).toMatchObject({ tipo: 'video', url: 'https://x/v.mp4' })
    expect(applyInboundMediaFields(base(), { type: 'sticker', stickerUrl: 'https://x/s.webp' })).toMatchObject({ tipo: 'sticker', nome_arquivo: 'sticker.webp' })
  })

  test('location: só grava location_meta quando há lat/lng', () => {
    const comMeta = applyInboundMediaFields(base(), { type: 'location', locationMeta: { latitude: -19, longitude: -48 } })
    expect(comMeta).toMatchObject({ tipo: 'location', nome_arquivo: 'localização', location_meta: { latitude: -19, longitude: -48 } })
    const semMeta = applyInboundMediaFields(base(), { type: 'location', locationMeta: {} })
    expect(semMeta.location_meta).toBeUndefined()
  })

  test('contact: só grava contact_meta quando tem nome ou telefone', () => {
    const comMeta = applyInboundMediaFields(base(), { type: 'contact', contactMeta: { nome: 'Zé' } })
    expect(comMeta).toMatchObject({ tipo: 'contact', contact_meta: { nome: 'Zé' } })
    const semMeta = applyInboundMediaFields(base(), { type: 'contact', contactMeta: {} })
    expect(semMeta.contact_meta).toBeUndefined()
  })

  test('reaction → tipo reaction; texto/desconhecido → não seta tipo', () => {
    expect(applyInboundMediaFields(base(), { type: 'reaction' }).tipo).toBe('reaction')
    expect(applyInboundMediaFields(base(), { type: 'text' }).tipo).toBeUndefined()
  })
})
