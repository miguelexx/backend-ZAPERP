/**
 * Mídia recebida SEM link do provedor (Whapi só manda `link` com `media.auto_download` ligado;
 * UltraMsg entrega `media:""` em certas instâncias).
 *
 * Dois defeitos reais que estes testes travam:
 *  (1) foto/vídeo/documento viravam '(mídia)' e eram DESCARTADOS pelo webhook — a mensagem do
 *      cliente sumia do atendimento e, sem linha no banco, nada tinha o que reparar depois;
 *  (2) o áudio era gravado (texto '(áudio)'), o backfill buscava a mídia no provedor e ENCONTRAVA,
 *      mas o reparo só aceitava linha com texto exatamente '(mensagem)' — a URL era descartada e o
 *      áudio ficava mudo para sempre.
 */

const { _test: whapiTest } = require('../controllers/webhookWhapiController')
const { extractMessage } = require('../controllers/webhookInbound/payload')
const { applyInboundMediaFields } = require('../controllers/webhookInbound/persistMensagem')
const { precisaBackfillMidia } = require('../services/inboundMediaBackfillService')
const { _test: syncTest } = require('../services/oldMessagesSyncService')
const { buildConversaAtualizadaPayload } = require('../controllers/webhookInbound/realtimePayload')

const CTX = { channelId: 'CANAL-1', connectedPhone: '5511999990000' }
const BASE = {
  id: 'MSG-1',
  from_me: false,
  chat_id: '5511988887777@s.whatsapp.net',
  from: '5511988887777',
  timestamp: 1760500000,
  from_name: 'Cliente',
}

/** Roda o pipeline real do inbound e devolve o que o webhook decidiria gravar. */
function processarWhapi(m) {
  const normalizado = whapiTest.normalizeWhapiMessageToInternal(m, CTX)
  const ex = extractMessage(normalizado)
  const insert = applyInboundMediaFields({ texto: ex.texto }, {
    type: ex.type,
    imageUrl: ex.imageUrl,
    documentUrl: ex.documentUrl,
    audioUrl: ex.audioUrl,
    videoUrl: ex.videoUrl,
    stickerUrl: ex.stickerUrl,
    locationUrl: ex.locationUrl,
    fileName: ex.fileName,
  })
  const temAlgumaUrl = [ex.imageUrl, ex.documentUrl, ex.audioUrl, ex.videoUrl, ex.stickerUrl, ex.locationUrl]
    .some(Boolean)
  return {
    texto: ex.texto,
    tipoGravado: insert.tipo || 'texto',
    // Mesma condição do webhookZapiController: só isto faz o inbound ser jogado fora.
    descartado: ex.texto === '(mídia)' && !temAlgumaUrl,
  }
}

describe('inbound de mídia sem link — nada mais é descartado em silêncio', () => {
  test('foto sem link vira placeholder tipado e é gravada', () => {
    const r = processarWhapi({ ...BASE, type: 'image', image: { id: 'm1', mime_type: 'image/jpeg' } })
    expect(r.texto).toBe('(imagem)')
    expect(r.descartado).toBe(false)
  })

  test('vídeo sem link vira placeholder tipado e é gravado', () => {
    const r = processarWhapi({ ...BASE, type: 'video', video: { id: 'm2', mime_type: 'video/mp4' } })
    expect(r.texto).toBe('(vídeo)')
    expect(r.descartado).toBe(false)
  })

  test('documento sem link usa o nome do arquivo e é gravado', () => {
    const r = processarWhapi({
      ...BASE,
      type: 'document',
      document: { id: 'm3', file_name: 'nota.pdf', mime_type: 'application/pdf' },
    })
    expect(r.texto).toBe('nota.pdf')
    expect(r.descartado).toBe(false)
  })

  test('áudio sem link continua gravado com tipo audio (regressão do comportamento que já funcionava)', () => {
    const r = processarWhapi({ ...BASE, type: 'voice', voice: { id: 'm4', mime_type: 'audio/ogg' } })
    expect(r.texto).toBe('(áudio)')
    expect(r.tipoGravado).toBe('audio')
    expect(r.descartado).toBe(false)
  })

  test('evento sem tipo reconhecível ainda é descartado (não gravar lixo)', () => {
    const r = processarWhapi({ ...BASE, type: 'unknown_thing' })
    expect(r.texto).toBe('(mídia)')
    expect(r.descartado).toBe(true)
  })

  test('mídia COM link segue intacta', () => {
    const r = processarWhapi({
      ...BASE,
      type: 'image',
      image: { id: 'm5', mime_type: 'image/jpeg', link: 'https://cdn/x.jpg', caption: 'olha' },
    })
    expect(r.texto).toBe('olha')
    expect(r.tipoGravado).toBe('imagem')
    expect(r.descartado).toBe(false)
  })
})

describe('backfill — foto com legenda não deixa rastro na linha, só o tipo do webhook', () => {
  test('linha de legenda sem url: sem a dica do webhook ninguém buscaria o arquivo', () => {
    const linha = { tipo: 'texto', texto: 'olha isso', url: null }
    expect(precisaBackfillMidia(linha)).toBe(false)
    expect(precisaBackfillMidia(linha, 'image')).toBe(true)
  })

  test('linha já com url utilizável nunca agenda backfill, mesmo com a dica', () => {
    expect(precisaBackfillMidia({ tipo: 'imagem', texto: 'x', url: '/uploads/a.jpg' }, 'image')).toBe(false)
  })

  test('placeholder tipado continua agendando sem precisar da dica', () => {
    expect(precisaBackfillMidia({ tipo: 'audio', texto: '(áudio)', url: null })).toBe(true)
  })
})

describe('reparo do histórico — a URL encontrada é realmente gravada', () => {
  const { buildPlaceholderRepairPatch } = syncTest

  test('áudio sem url ganha a URL do provedor (era o caso que o reparo recusava)', () => {
    const patch = buildPlaceholderRepairPatch(
      { id: 7, texto: '(áudio)', tipo: 'audio', url: null },
      { texto: '(áudio)', tipo: 'audio', url: 'https://cdn/a.ogg', nome_arquivo: 'voice.ogg' }
    )
    expect(patch).toEqual({ url: 'https://cdn/a.ogg', tipo: 'audio', nome_arquivo: 'voice.ogg' })
  })

  test('placeholder genérico vira tipado', () => {
    const patch = buildPlaceholderRepairPatch(
      { id: 8, texto: '(mensagem)', tipo: 'texto', url: null },
      { texto: '(áudio)', tipo: 'audio' }
    )
    expect(patch).toEqual({ texto: '(áudio)' })
  })

  test('placeholder vira texto real', () => {
    const patch = buildPlaceholderRepairPatch(
      { id: 9, texto: '(mídia)', tipo: 'texto', url: null },
      { texto: 'bom dia' }
    )
    expect(patch).toEqual({ texto: 'bom dia' })
  })

  test('texto real NUNCA é rebaixado a placeholder', () => {
    expect(
      buildPlaceholderRepairPatch(
        { id: 10, texto: 'bom dia', tipo: 'texto', url: null },
        { texto: '(mídia)' }
      )
    ).toBeNull()
  })

  test('url utilizável (inclusive /uploads e /media/r2) nunca é sobrescrita', () => {
    expect(
      buildPlaceholderRepairPatch(
        { id: 11, texto: '(áudio)', tipo: 'audio', url: '/uploads/a.ogg' },
        { texto: '(áudio)', tipo: 'audio', url: 'https://cdn/outro.ogg' }
      )
    ).toBeNull()
    expect(
      buildPlaceholderRepairPatch(
        { id: 12, texto: '(áudio)', tipo: 'audio', url: '/media/r2/k' },
        { texto: '(áudio)', tipo: 'audio', url: 'https://cdn/outro.ogg' }
      )
    ).toBeNull()
  })

  test('nada novo a aplicar devolve null (não gera UPDATE à toa)', () => {
    expect(
      buildPlaceholderRepairPatch(
        { id: 13, texto: '(áudio)', tipo: 'audio', url: null },
        { texto: '(áudio)', tipo: 'audio' }
      )
    ).toBeNull()
  })
})

describe('preview da lista lateral leva o tipo', () => {
  function preview(emitPayload) {
    const p = buildConversaAtualizadaPayload({
      convIdForEmit: 1,
      convRow: { id: 1, status_atendimento: 'aberta' },
      whatsappInstanceId: 1,
      skipChatbotPorCampanha: false,
      isGroup: false,
      depId: null,
      contatoNome: null,
      fotoPerfil: null,
      mensagemFoiInseridaPeloWebhook: true,
      fromMe: false,
      modoSimplesRecalc: null,
      emitPayload,
    })
    return p.ultima_mensagem_preview
  }

  test('áudio: o card recebe o tipo em vez de só o placeholder cru', () => {
    expect(preview({ texto: '(áudio)', tipo: 'audio', criado_em: 'x', direcao: 'in' }).tipo).toBe('audio')
  })

  test('arquivo: leva nome_arquivo para o card mostrar o nome', () => {
    const p = preview({ texto: '(arquivo)', tipo: 'arquivo', nome_arquivo: 'nota.pdf', criado_em: 'x', direcao: 'in' })
    expect(p.tipo).toBe('arquivo')
    expect(p.nome_arquivo).toBe('nota.pdf')
  })

  test('contact segue levando contact_meta (comportamento antigo preservado)', () => {
    const p = preview({ texto: 'Zé', tipo: 'contact', contact_meta: { nome: 'Zé' }, criado_em: 'x', direcao: 'in' })
    expect(p.tipo).toBe('contact')
    expect(p.contact_meta).toEqual({ nome: 'Zé' })
  })
})
