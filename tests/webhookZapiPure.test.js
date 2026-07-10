/**
 * Testes unitários para funções puras do webhookZapiController.
 * Sem dependências de Supabase ou I/O externo — cobre normalização de payload Z-API,
 * resolução de chave de conversa, extração de mensagem e desempacotamento de envelopes.
 */

const { _test } = require('../controllers/webhookZapiController')
const {
  looksLikeBRPhoneDigits,
  isGroupPayload,
  pickGroupChatId,
  getPayloads,
  resolveConversationKeyFromZapi,
  extractMessage,
  resolvePlaceholderUpgradeTexto,
  familiaMidiaDeMensagemExistente,
} = _test

// Silencia console.warn (resolveConversationKeyFromZapi avisa quando connectedPhone está ausente)
beforeAll(() => { jest.spyOn(console, 'warn').mockImplementation(() => {}) })
afterAll(() => { jest.restoreAllMocks() })

// ─────────────────────────── looksLikeBRPhoneDigits ───────────────────────────
describe('looksLikeBRPhoneDigits', () => {
  test.each([
    ['5511999999999', true,  '13 dígitos BR (55+DDD+9+8)'],
    ['551133333333',  true,  '12 dígitos BR (55+DDD+8)'],
    ['11999999999',   true,  '11 dígitos sem DDI'],
    ['1133333333',    true,  '10 dígitos sem DDI'],
    ['4911234567890', false, '13 dígitos não-BR (Alemanha)'],
    ['123456789',     false, '9 dígitos — muito curto'],
    ['',              false, 'string vazia'],
    [null,            false, 'null'],
  ])('%s → %s (%s)', (input, expected) => {
    expect(looksLikeBRPhoneDigits(input)).toBe(expected)
  })
})

// ─────────────────────────── isGroupPayload ───────────────────────────────────
describe('isGroupPayload', () => {
  test('isGroup: true explícito', () =>
    expect(isGroupPayload({ isGroup: true })).toBe(true))
  test('tipo: grupo', () =>
    expect(isGroupPayload({ tipo: 'grupo' })).toBe(true))
  test('type: GROUP (maiúsculo)', () =>
    expect(isGroupPayload({ type: 'GROUP' })).toBe(true))
  test('phone @g.us', () =>
    expect(isGroupPayload({ phone: '120363123456789012@g.us' })).toBe(true))
  test('key.remoteJid @g.us', () =>
    expect(isGroupPayload({ key: { remoteJid: '120363123456789012@g.us' } })).toBe(true))
  test('chatId 120... 17 dígitos sem participante (regra 3)', () =>
    expect(isGroupPayload({ chatId: '12036312345678901' })).toBe(true))
  test('phone 120... + participantPhone (regra 2)', () =>
    expect(isGroupPayload({ phone: '12036312345678901', participantPhone: '5511999999999' })).toBe(true))
  test('número individual não é grupo', () =>
    expect(isGroupPayload({ phone: '5511999999999' })).toBe(false))
  test('payload vazio', () =>
    expect(isGroupPayload({})).toBe(false))
  test('null', () =>
    expect(isGroupPayload(null)).toBe(false))
})

// ─────────────────────────── pickGroupChatId ──────────────────────────────────
describe('pickGroupChatId', () => {
  test('key.remoteJid @g.us (canônico)', () =>
    expect(pickGroupChatId({ key: { remoteJid: '120363123456789@g.us' } })).toBe('120363123456789@g.us'))
  test('phone -group (regra 2)', () =>
    expect(pickGroupChatId({ phone: 'abc-group-xyz' })).toBe('abc-group-xyz'))
  test('phone 120... só dígitos (regra 3)', () =>
    expect(pickGroupChatId({ phone: '12036312345678901' })).toBe('12036312345678901'))
  test('chatId @g.us tem prioridade sobre phone numérico', () =>
    expect(pickGroupChatId({ chatId: '120363123456789@g.us', phone: '12036312345678901' })).toBe('120363123456789@g.us'))
  test('número individual → string vazia', () =>
    expect(pickGroupChatId({ phone: '5511999999999' })).toBe(''))
  test('null → string vazia', () =>
    expect(pickGroupChatId(null)).toBe(''))
})

// ─────────────────────────── getPayloads ─────────────────────────────────────
describe('getPayloads', () => {
  test('null → [{}]', () =>
    expect(getPayloads(null)).toEqual([{}]))

  test('objeto simples passthrough', () =>
    expect(getPayloads({ phone: 'a' })).toEqual([{ phone: 'a' }]))

  test('array de payloads passthrough', () =>
    expect(getPayloads([{ phone: 'a' }, { phone: 'b' }])).toEqual([{ phone: 'a' }, { phone: 'b' }]))

  test('body.data array → merge com campos do body pai', () => {
    const result = getPayloads({ data: [{ phone: 'a' }], instanceId: 'X' })
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ phone: 'a', instanceId: 'X' })
  })

  test('body.data objeto → merge', () => {
    const result = getPayloads({ data: { phone: 'a' }, instanceId: 'X' })
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ phone: 'a', instanceId: 'X' })
  })

  test('body.value objeto → merge', () => {
    const result = getPayloads({ value: { phone: 'a' }, instanceId: 'X' })
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ phone: 'a', instanceId: 'X' })
  })

  test('body.value preserva key.remoteJid do pai (caso Z-API: mensagem em value, key na raiz)', () => {
    const result = getPayloads({ key: { remoteJid: '5511999@c.us' }, value: { phone: '5511999' } })
    expect(result[0].key).toMatchObject({ remoteJid: '5511999@c.us' })
  })

  test('body.messages array → merge com body pai', () => {
    const result = getPayloads({ messages: [{ phone: 'a' }], instanceId: 'X' })
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ phone: 'a', instanceId: 'X' })
  })

  test('body.message objeto → merge', () => {
    const result = getPayloads({ message: { phone: 'a' }, instanceId: 'X' })
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ phone: 'a', instanceId: 'X' })
  })
})

// ─────────────────────────── resolveConversationKeyFromZapi ──────────────────
describe('resolveConversationKeyFromZapi', () => {
  const CONN = '5544888888888'

  test('individual inbound — phone BR padrão', () => {
    const { key, isGroup, participantPhone } = resolveConversationKeyFromZapi({
      phone: '5511999999999', connectedPhone: CONN, fromMe: false,
    })
    expect(key).toBe('5511999999999')
    expect(isGroup).toBe(false)
    expect(participantPhone).toBe('')
  })

  test('fromMe=true — usa key.remoteJid como destino (nunca connectedPhone)', () => {
    const { key, isGroup } = resolveConversationKeyFromZapi({
      fromMe: true, connectedPhone: CONN,
      key: { remoteJid: '5511999999999@c.us', fromMe: true },
    })
    expect(key).toBe('5511999999999')
    expect(isGroup).toBe(false)
  })

  test('fromMe=true — usa campo to quando key.remoteJid ausente', () => {
    const { key } = resolveConversationKeyFromZapi({
      fromMe: true, connectedPhone: CONN, phone: CONN, to: '5511999999999',
    })
    expect(key).toBe('5511999999999')
  })

  test('grupo @g.us — retorna id normalizado + participantPhone', () => {
    const { key, isGroup, participantPhone } = resolveConversationKeyFromZapi({
      isGroup: true,
      phone: '120363123456789012@g.us',
      participantPhone: '5511333333333',
      connectedPhone: CONN,
    })
    expect(key).toBe('120363123456789012')
    expect(isGroup).toBe(true)
    expect(participantPhone).toBe('5511333333333')
  })

  test('payload LID — retorna chave sintética lid:', () => {
    const { key, isGroup } = resolveConversationKeyFromZapi({
      phone: '280396956696801@lid', fromMe: false,
    })
    expect(key).toBe('lid:280396956696801')
    expect(isGroup).toBe(false)
  })

  test('phone === connectedPhone — não retorna meu próprio número como chave', () => {
    const { key } = resolveConversationKeyFromZapi({
      phone: CONN, connectedPhone: CONN, fromMe: false,
    })
    expect(key).toBe('')
  })

  test('payload sem destino válido — retorna key vazio', () => {
    const { key } = resolveConversationKeyFromZapi({ fromMe: false })
    expect(key).toBe('')
  })
})

// ─────────────────────────── extractMessage ───────────────────────────────────
describe('extractMessage', () => {
  // Payload base: número real, connectedPhone, timestamp em ms
  const BASE = { connectedPhone: '5544888888888', phone: '5511999999999', timestamp: 1700000000000 }

  test('null → objeto padrão seguro com phone vazio', () => {
    const r = extractMessage(null)
    expect(r.phone).toBe('')
    expect(r.texto).toBe('(vazio)')
    expect(r.type).toBe('text')
    expect(r.fromMe).toBe(false)
    expect(r.messageId).toBeNull()
    expect(r.isGroup).toBe(false)
  })

  test('texto simples — tipo text, messageId, fromMe=false', () => {
    const r = extractMessage({ ...BASE, message: 'Olá!', type: 'text', messageId: 'MSG_1' })
    expect(r.type).toBe('text')
    expect(r.texto).toBe('Olá!')
    expect(r.fromMe).toBe(false)
    expect(r.messageId).toBe('MSG_1')
    expect(r.phone).toBe('5511999999999')
  })

  test('texto com URL → tipo link', () => {
    const r = extractMessage({ ...BASE, message: 'Veja https://example.com aqui', type: 'text' })
    expect(r.type).toBe('link')
    expect(r.texto).toContain('https://example.com')
  })

  test('imagem com caption', () => {
    const r = extractMessage({
      ...BASE,
      image: { imageUrl: 'https://cdn/img.jpg', caption: 'Foto da reunião' },
      type: 'image',
    })
    expect(r.type).toBe('image')
    expect(r.imageUrl).toBe('https://cdn/img.jpg')
    expect(r.texto).toBe('Foto da reunião')
  })

  test('áudio — texto padrão (áudio)', () => {
    const r = extractMessage({ ...BASE, audio: { audioUrl: 'https://cdn/aud.ogg' }, type: 'audio' })
    expect(r.type).toBe('audio')
    expect(r.audioUrl).toBe('https://cdn/aud.ogg')
    expect(r.texto).toBe('(áudio)')
  })

  test('vídeo com caption', () => {
    const r = extractMessage({
      ...BASE,
      video: { videoUrl: 'https://cdn/vid.mp4', caption: 'Clipe do evento' },
      type: 'video',
    })
    expect(r.type).toBe('video')
    expect(r.videoUrl).toBe('https://cdn/vid.mp4')
    expect(r.texto).toBe('Clipe do evento')
  })

  test('documento com fileName → texto = nome do arquivo', () => {
    const r = extractMessage({
      ...BASE,
      document: { documentUrl: 'https://cdn/doc.pdf', fileName: 'relatorio.pdf' },
      type: 'document',
    })
    expect(r.type).toBe('document')
    expect(r.documentUrl).toBe('https://cdn/doc.pdf')
    expect(r.fileName).toBe('relatorio.pdf')
    expect(r.texto).toBe('relatorio.pdf')
  })

  test('sticker — texto padrão (figurinha)', () => {
    const r = extractMessage({ ...BASE, sticker: { stickerUrl: 'https://cdn/stk.webp' } })
    expect(r.type).toBe('sticker')
    expect(r.stickerUrl).toBe('https://cdn/stk.webp')
    expect(r.texto).toBe('(figurinha)')
  })

  test.each([
    [
      'image',
      { type: 'image', image: { imageUrl: 'https://cdn/img-sem-legenda.jpg' } },
      { type: 'image', texto: '(imagem)', urlField: 'imageUrl', url: 'https://cdn/img-sem-legenda.jpg' },
    ],
    [
      'audio',
      { type: 'audio', audio: { audioUrl: 'https://cdn/audio-sem-legenda.ogg' } },
      { type: 'audio', texto: '(áudio)', urlField: 'audioUrl', url: 'https://cdn/audio-sem-legenda.ogg' },
    ],
    [
      'video',
      { type: 'video', video: { videoUrl: 'https://cdn/video-sem-legenda.mp4' } },
      { type: 'video', texto: '(vídeo)', urlField: 'videoUrl', url: 'https://cdn/video-sem-legenda.mp4' },
    ],
    [
      'document',
      { type: 'document', document: { documentUrl: 'https://cdn/arquivo-sem-legenda.pdf' } },
      { type: 'document', texto: '(arquivo)', urlField: 'documentUrl', url: 'https://cdn/arquivo-sem-legenda.pdf' },
    ],
    [
      'sticker',
      { type: 'sticker', sticker: { stickerUrl: 'https://cdn/figurinha-sem-legenda.webp' } },
      { type: 'sticker', texto: '(figurinha)', urlField: 'stickerUrl', url: 'https://cdn/figurinha-sem-legenda.webp' },
    ],
  ])('client media without caption is still a persistable message: %s', (_label, payload, expected) => {
    const r = extractMessage({ ...BASE, ...payload })
    expect(r.fromMe).toBe(false)
    expect(r.phone).toBe(BASE.phone)
    expect(r.type).toBe(expected.type)
    expect(r.texto).toBe(expected.texto)
    expect(r[expected.urlField]).toBe(expected.url)
  })

  test('reação com emoji', () => {
    const r = extractMessage({ ...BASE, reaction: { value: '👍' } })
    expect(r.type).toBe('reaction')
    expect(r.texto).toBe('Reação: 👍')
  })

  test('localização com nome e coordenadas → locationMeta + texto formatado', () => {
    const r = extractMessage({
      ...BASE,
      location: { name: 'Av. Paulista', latitude: -23.5606, longitude: -46.6560 },
    })
    expect(r.type).toBe('location')
    expect(r.texto).toContain('Av. Paulista')
    expect(r.texto).toContain('-23.56060')
    expect(r.locationMeta).toMatchObject({
      latitude: -23.5606,
      longitude: -46.656,
      nome: 'Av. Paulista',
      endereco: null,
    })
  })

  test('contato → contactMeta com nome e telefone', () => {
    const r = extractMessage({
      ...BASE,
      contact: { displayName: 'João Silva', phone: '5511888888888' },
    })
    expect(r.type).toBe('contact')
    expect(r.texto).toBe('João Silva')
    expect(r.contactMeta).toMatchObject({ nome: 'João Silva', telefone: '5511888888888' })
  })

  test('mensagem de grupo — isGroup, participantPhone, nomeGrupo', () => {
    const r = extractMessage({
      ...BASE,
      isGroup: true,
      phone: '120363123456789012@g.us',
      participantPhone: '5511999999999',
      message: 'Oi grupo',
      chatName: 'Time Tech',
    })
    expect(r.isGroup).toBe(true)
    expect(r.phone).toBe('120363123456789012')
    expect(r.participantPhone).toBe('5511999999999')
    expect(r.nomeGrupo).toBe('Time Tech')
    expect(r.texto).toBe('Oi grupo')
  })

  test('fromMe=true — phone = destino (não connectedPhone)', () => {
    const r = extractMessage({
      ...BASE,
      fromMe: true,
      key: { remoteJid: '5511999999999@c.us', fromMe: true },
      message: 'Mensagem enviada',
    })
    expect(r.fromMe).toBe(true)
    expect(r.phone).toBe('5511999999999')
    expect(r.isGroup).toBe(false)
  })

  test('timestamp em segundos é normalizado para ms', () => {
    const r = extractMessage({ ...BASE, message: 'Hi', timestamp: 1700000000 })
    expect(new Date(r.criado_em).getTime()).toBe(1700000000 * 1000)
  })

  test('messageId: zaapId tem prioridade sobre key.id', () => {
    const r = extractMessage({ ...BASE, zaapId: 'ZAAP_1', key: { id: 'KEY_1' } })
    expect(r.messageId).toBe('ZAAP_1')
  })
})

// ─────────────────────────── fromMe reconcile helpers ─────────────────────────
describe('fromMe reconcile helpers', () => {
  const {
    whatsappIdCompativelParaReconcile,
    filterRowsForFromMeReconcile,
    findFromMeOutboundMediaCandidate,
  } = _test

  test('whatsappIdCompativelParaReconcile: fila numérica → id real WhatsApp', () => {
    const row = { id: 1, whatsapp_id: '35096', texto: 'Vamos', tipo: 'texto', direcao: 'out' }
    const realId = 'false_5511999999999@c.us_ABC'
    expect(whatsappIdCompativelParaReconcile(row, realId)).toBe(true)
    expect(whatsappIdCompativelParaReconcile(row, '35096')).toBe(true)
    expect(whatsappIdCompativelParaReconcile(row, '99999')).toBe(false)
  })

  test('filterRowsForFromMeReconcile inclui null e fila, exclui id real', () => {
    const rows = [
      { id: 1, whatsapp_id: null },
      { id: 2, whatsapp_id: '35096' },
      { id: 3, whatsapp_id: 'false_5511@c.us_X' },
    ]
    const filtered = filterRowsForFromMeReconcile(rows)
    expect(filtered.map((r) => r.id)).toEqual([1, 2])
  })

  test('findFromMeOutboundMediaCandidate casa texto CRM com eco webhook prefixado', () => {
    const rows = [
      { id: 10, whatsapp_id: '35096', texto: 'Vamos', tipo: 'texto', autor_usuario_id: 5 },
    ]
    const cand = findFromMeOutboundMediaCandidate(rows, {
      texto: '*Wagner*\nVamos',
      tipo: 'texto',
      nomeAtendente: 'Wagner',
      whatsappId: 'false_5511@c.us_ABC',
    })
    expect(cand?.id).toBe(10)
  })
})

// ─────────────────────────── resolvePlaceholderUpgradeTexto ───────────────────────────
// Upgrade '(mensagem)'/'(mídia)' → placeholder tipado quando um webhook posterior conhece o
// tipo mas a URL da mídia ainda não chegou (áudio pelo celular: create fora de ordem +
// download_media atrasado deixava a bolha "(mensagem)" para sempre).
describe('resolvePlaceholderUpgradeTexto', () => {
  test.each([
    ['(mensagem)', '(áudio)',   '(áudio)',   'genérico → áudio (caso do áudio pelo celular)'],
    ['(mensagem)', '(imagem)',  '(imagem)',  'genérico → imagem'],
    ['(mensagem)', '(vídeo)',   '(vídeo)',   'genérico → vídeo'],
    ['(mensagem)', '(figurinha)', '(figurinha)', 'genérico → figurinha'],
    ['(mensagem)', '(arquivo)', '(arquivo)', 'genérico → arquivo'],
    ['(mídia)',    '(áudio)',   '(áudio)',   'mídia genérica → áudio'],
    ['(mensagem)', '(vídeo visualização única)', '(vídeo visualização única)', 'genérico → ptv'],
  ])('%s + %s → %s (%s)', (saved, incoming, expected) => {
    expect(resolvePlaceholderUpgradeTexto(saved, incoming)).toBe(expected)
  })

  test.each([
    ['(mensagem)', '(mensagem)', 'mesmo genérico — nada a fazer'],
    ['(mensagem)', '(mídia)',    'genérico → genérico não melhora'],
    ['(mensagem)', 'Oi, tudo bem?', 'texto real é tratado por textoReal, não aqui'],
    ['(mensagem)', '',           'incoming vazio'],
    ['(áudio)',    '(imagem)',   'tipado nunca troca por outro tipado (anti flip-flop)'],
    ['(áudio)',    '(mensagem)', 'tipado nunca regride para genérico'],
    ['Texto real', '(áudio)',    'texto real salvo nunca é sobrescrito'],
    ['',           '(áudio)',    'saved vazio não é genérico'],
    [null,         '(áudio)',    'saved null'],
    ['(mensagem)', null,         'incoming null'],
  ])('%s + %s → null (%s)', (saved, incoming) => {
    expect(resolvePlaceholderUpgradeTexto(saved, incoming)).toBe(null)
  })
})

// ─────────────────────────── familiaMidiaDeMensagemExistente ───────────────────────────
// Evento posterior com URL genérica (data.media, S3 sem extensão) e sem type: a família vem
// da PRÓPRIA linha existente (tipo gravado ou placeholder tipado no texto).
describe('familiaMidiaDeMensagemExistente', () => {
  test.each([
    [{ tipo: 'voice', texto: '(áudio)' }, 'voice', 'tipo voice gravado'],
    [{ tipo: 'audio', texto: '' }, 'audio', 'tipo audio gravado'],
    [{ tipo: 'texto', texto: '(áudio)' }, 'voice', 'placeholder áudio com acento'],
    [{ tipo: 'texto', texto: '(audio)' }, 'voice', 'placeholder audio ASCII'],
    [{ tipo: 'texto', texto: '(imagem)' }, 'imagem', 'placeholder imagem'],
    [{ tipo: 'texto', texto: '(vídeo)' }, 'video', 'placeholder vídeo'],
    [{ tipo: 'texto', texto: '(vídeo visualização única)' }, 'video', 'placeholder ptv'],
    [{ tipo: 'texto', texto: '(figurinha)' }, 'sticker', 'placeholder figurinha'],
    [{ tipo: 'texto', texto: '(arquivo)' }, 'arquivo', 'placeholder arquivo'],
    [{ tipo: 'texto', texto: 'Oi, tudo bem?' }, null, 'texto real não é mídia'],
    [{ tipo: 'texto', texto: '(mensagem)' }, null, 'genérico não tem família'],
    [{ tipo: 'location', texto: '' }, null, 'location não recebe URL genérica'],
    [null, null, 'null'],
  ])('%j → %s (%s)', (existente, expected) => {
    expect(familiaMidiaDeMensagemExistente(existente)).toBe(expected)
  })
})
