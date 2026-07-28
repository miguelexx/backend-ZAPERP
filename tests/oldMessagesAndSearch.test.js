const { normalizeOldMessage, buildPlaceholderRepairPatch } = require('../services/oldMessagesSyncService')
const {
  buildClienteSearchOr,
  buildTelefoneSearchOr,
  buildPhoneSearchTerms,
} = require('../helpers/chatSearchHelper')

describe('old messages contact sync', () => {
  test('marca item sem texto/midia como placeholder vazio para nao importar preview falso', () => {
    const normalized = normalizeOldMessage(
      {
        id: 'wamid-empty-1',
        fromMe: false,
        timestamp: 1760000000,
        type: 'text',
      },
      { isGroup: false }
    )

    expect(normalized?.insert?.texto).toBe('(mensagem)')
    expect(normalized?.emptyPlaceholder).toBe(true)
  })

  test('mantem midia reconhecida mesmo sem legenda', () => {
    const normalized = normalizeOldMessage(
      {
        id: 'wamid-image-1',
        fromMe: false,
        timestamp: 1760000000,
        type: 'image',
        imageUrl: 'https://cdn.example.test/image.jpg',
      },
      { isGroup: false }
    )

    expect(normalized?.insert?.tipo).toBe('imagem')
    expect(normalized?.insert?.texto).toBe('(imagem)')
    expect(normalized?.emptyPlaceholder).toBe(false)
  })

  // Formato REAL do GET /messages da UltraMsg: a URL vem em `media` (não em imageUrl/audioUrl).
  // Antes, toda mídia do sync caía em "(mensagem)" e era pulada — áudios/fotos sumiam do histórico.
  test('audio ptt com URL em media (formato UltraMsg) vira voice com url', () => {
    const normalized = normalizeOldMessage(
      {
        id: 'false_5534@c.us_AUDIO1',
        fromMe: false,
        time: 1760000000,
        type: 'ptt',
        body: '',
        media: 'https://cdn.ultramsg.com/media/voice-abc.ogg',
      },
      { isGroup: false }
    )

    expect(normalized?.insert?.tipo).toBe('voice')
    expect(normalized?.insert?.url).toBe('https://cdn.ultramsg.com/media/voice-abc.ogg')
    expect(normalized?.emptyPlaceholder).toBe(false)
  })

  test('imagem com URL em media + caption no body preserva legenda', () => {
    const normalized = normalizeOldMessage(
      {
        id: 'false_5534@c.us_IMG1',
        fromMe: true,
        time: 1760000000,
        type: 'image',
        body: 'Olha essa foto',
        media: 'https://cdn.ultramsg.com/media/foto.jpg',
      },
      { isGroup: false }
    )

    expect(normalized?.insert?.tipo).toBe('imagem')
    expect(normalized?.insert?.url).toBe('https://cdn.ultramsg.com/media/foto.jpg')
    expect(normalized?.insert?.texto).toBe('Olha essa foto')
    expect(normalized?.insert?.direcao).toBe('out')
  })

  test('type alias "voice" de aparelho variante com media vira voice', () => {
    const normalized = normalizeOldMessage(
      {
        id: 'false_5534@c.us_AUDIO2',
        fromMe: false,
        time: 1760000000,
        type: 'voice',
        body: '',
        media: 'https://cdn.ultramsg.com/media/voice-x.oga',
      },
      { isGroup: false }
    )
    expect(normalized?.insert?.tipo).toBe('voice')
    expect(normalized?.insert?.url).toBe('https://cdn.ultramsg.com/media/voice-x.oga')
  })

  test('type MIME cru "audio/ogg; codecs=opus" com media vira voice', () => {
    const normalized = normalizeOldMessage(
      {
        id: 'false_5534@c.us_AUDIO3',
        fromMe: false,
        time: 1760000000,
        type: 'audio/ogg; codecs=opus',
        body: '',
        media: 'https://cdn.ultramsg.com/media/voice-y.ogg',
      },
      { isGroup: false }
    )
    expect(normalized?.insert?.tipo).toBe('voice')
    expect(normalized?.insert?.url).toBe('https://cdn.ultramsg.com/media/voice-y.ogg')
  })

  test('type=chat sem texto com media .ogg infere voice por extensao', () => {
    const normalized = normalizeOldMessage(
      {
        id: 'false_5534@c.us_AUDIO4',
        fromMe: false,
        time: 1760000000,
        type: 'chat',
        body: '',
        media: 'https://cdn.ultramsg.com/media/voice-z.ogg?token=1',
      },
      { isGroup: false }
    )
    expect(normalized?.insert?.tipo).toBe('voice')
    expect(normalized?.insert?.url).toBe('https://cdn.ultramsg.com/media/voice-z.ogg?token=1')
  })

  test('documento com media + filename', () => {
    const normalized = normalizeOldMessage(
      {
        id: 'false_5534@c.us_DOC1',
        fromMe: false,
        time: 1760000000,
        type: 'document',
        body: 'contrato.pdf',
        media: 'https://cdn.ultramsg.com/docs/contrato.pdf',
        filename: 'contrato.pdf',
      },
      { isGroup: false }
    )
    expect(normalized?.insert?.tipo).toBe('arquivo')
    expect(normalized?.insert?.url).toBe('https://cdn.ultramsg.com/docs/contrato.pdf')
    expect(normalized?.emptyPlaceholder).toBe(false)
  })

  test('texto normal com type=chat NAO e reclassificado', () => {
    const normalized = normalizeOldMessage(
      {
        id: 'false_5534@c.us_TXT1',
        fromMe: false,
        time: 1760000000,
        type: 'chat',
        body: 'Oi, tudo bem?',
      },
      { isGroup: false }
    )
    expect(normalized?.insert?.tipo).toBeUndefined()
    expect(normalized?.insert?.texto).toBe('Oi, tudo bem?')
    expect(normalized?.emptyPlaceholder).toBe(false)
  })
})

// Reparo de linhas quebradas pelo sync: agora cobre placeholders TIPADOS ('(áudio)' sem URL,
// de instância com download_media desligado), não só '(mensagem)'.
describe('buildPlaceholderRepairPatch', () => {
  const S3 = 'https://s3.eu-central-1.amazonaws.com/ultramsgmedia/2026/7/182261/abc123'

  test('linha "(áudio)" tipo texto sem url + provider com url → ganha url e tipo voice', () => {
    const patch = buildPlaceholderRepairPatch(
      { id: 1, texto: '(áudio)', tipo: 'texto', url: null },
      { texto: '(audio)', tipo: 'voice', url: S3, nome_arquivo: 'voice.ogg' }
    )
    expect(patch).toEqual({ tipo: 'voice', url: S3, nome_arquivo: 'voice.ogg' })
  })

  test('linha "(mensagem)" + provider com texto real → texto substituído', () => {
    const patch = buildPlaceholderRepairPatch(
      { id: 1, texto: '(mensagem)', tipo: 'texto', url: null },
      { texto: 'Oi, tudo bem?' }
    )
    expect(patch).toEqual({ texto: 'Oi, tudo bem?' })
  })

  test('linha "(mensagem)" + provider tipado sem url → sobe para placeholder tipado', () => {
    const patch = buildPlaceholderRepairPatch(
      { id: 1, texto: '(mensagem)', tipo: 'texto', url: null },
      { texto: '(audio)' }
    )
    expect(patch).toEqual({ texto: '(audio)' })
  })

  test('linha "(imagem)" com caption real do provider → caption + url + tipo', () => {
    const patch = buildPlaceholderRepairPatch(
      { id: 1, texto: '(imagem)', tipo: 'texto', url: null },
      { texto: 'Olha essa foto', tipo: 'imagem', url: S3 }
    )
    expect(patch).toEqual({ texto: 'Olha essa foto', tipo: 'imagem', url: S3 })
  })

  test('texto real existente NUNCA é sobrescrito; só completa url de mídia perdida', () => {
    const semUrl = buildPlaceholderRepairPatch(
      { id: 1, texto: 'Orçamento fechado', tipo: 'texto', url: null },
      { texto: '(audio)', tipo: 'voice' }
    )
    expect(semUrl).toBe(null)

    const comUrl = buildPlaceholderRepairPatch(
      { id: 1, texto: 'legenda real', tipo: 'imagem', url: null },
      { texto: '(imagem)', tipo: 'imagem', url: S3 }
    )
    expect(comUrl).toEqual({ url: S3 })
  })

  test('linha já completa (url presente) → nada a reparar', () => {
    expect(
      buildPlaceholderRepairPatch(
        { id: 1, texto: '(áudio)', tipo: 'voice', url: '/uploads/inbound-x.ogg' },
        { texto: '(audio)', tipo: 'voice', url: S3 }
      )
    ).toBe(null)
  })

  test.each([false, 'false', 'null', 'undefined', '0'])(
    'URL sentinela antiga %p é substituída pela URL real do provider',
    (invalidUrl) => {
      const patch = buildPlaceholderRepairPatch(
        { id: 1, texto: '(arquivo)', tipo: 'arquivo', url: invalidUrl },
        { texto: '(arquivo)', tipo: 'arquivo', url: S3, nome_arquivo: 'comprovante.pdf' }
      )
      expect(patch).toEqual({ url: S3, nome_arquivo: 'comprovante.pdf' })
    }
  )

  test('tipo de mídia já definido nunca é trocado por outro', () => {
    const patch = buildPlaceholderRepairPatch(
      { id: 1, texto: '(áudio)', tipo: 'voice', url: null },
      { texto: '(imagem)', tipo: 'imagem', url: S3 }
    )
    expect(patch).toEqual({ url: S3 })
  })
})

describe('chat search helpers', () => {
  test('gera variacoes de telefone com e sem nono digito para busca em Todas', () => {
    expect(buildPhoneSearchTerms('11 3731-6767')).toEqual(
      expect.arrayContaining(['551137316767', '5511937316767'])
    )
    expect(buildPhoneSearchTerms('55 11 93731-6767')).toEqual(
      expect.arrayContaining(['5511937316767', '551137316767'])
    )
  })

  test('busca de cliente cobre nome, pushname e telefone', () => {
    const or = buildClienteSearchOr('Sompo')
    expect(or).toContain('nome.ilike."%Sompo%"')
    expect(or).toContain('pushname.ilike."%Sompo%"')
    expect(or).toContain('telefone.ilike."%Sompo%"')
  })

  test('busca de telefone em conversas usa termo bruto e variacoes numericas', () => {
    const or = buildTelefoneSearchOr('(11) 4082-1000')
    expect(or).toContain('telefone.ilike."%(11) 4082-1000%"')
    expect(or).toContain('telefone.ilike."%551140821000%"')
    expect(or).toContain('telefone.ilike."%5511940821000%"')
  })

  test('valor com parenteses (telefone mascarado) vai entre aspas duplas para nao quebrar o parser do .or() do PostgREST', () => {
    const or = buildTelefoneSearchOr('+55 (34) 9991-1246')
    // Sem aspas, "(" e ")" são caracteres de controle do .or() e quebram a expressão inteira.
    expect(or).not.toMatch(/ilike\.%/) // nenhuma condição sem aspas
    expect(or).toContain('telefone.ilike."%553499911246%"')
  })

  test('ignora fragmentos numericos curtos misturados em texto livre (evita falso positivo de telefone)', () => {
    // 'zzznonexistent999' so tem 3 digitos ('999') — curto demais para ser telefone,
    // mas casava com qualquer numero que contivesse "999" em qualquer posicao.
    expect(buildPhoneSearchTerms('zzznonexistent999')).toEqual([])
  })

  test('mantem busca por fragmento real de telefone com 4+ digitos', () => {
    expect(buildPhoneSearchTerms('1246')).toEqual(['1246'])
    expect(buildPhoneSearchTerms('9911246')).toEqual(expect.arrayContaining(['9911246']))
  })
})
