/**
 * Reprocesso manual de mídia inbound cuja URL já aponta ao Cloudflare R2 (/media/r2/<key>).
 * Antes, o fluxo caía em persistInboundMediaToUploads → 'sem_url_remota' → definitivo:true
 * e o painel mostrava "expirou no WhatsApp" para uma mídia perfeitamente viva no R2.
 */

describe('reprocessarMidiaInbound — mídia migrada ao R2', () => {
  afterEach(() => {
    jest.resetModules()
    jest.restoreAllMocks()
  })

  function montar({ url }) {
    jest.resetModules()
    jest.doMock('../config/supabase', () => ({
      from: () => {
        const chain = {
          select() { return chain },
          eq() { return chain },
          update() { return chain },
          maybeSingle: async () => ({
            data: {
              id: 7,
              conversa_id: 3,
              company_id: 1,
              direcao: 'in',
              tipo: 'audio',
              url,
              whatsapp_id: 'ABC123DEF456',
              whatsapp_instance_id: null,
            },
            error: null,
          }),
        }
        return chain
      },
    }))
    const persistInboundMediaToUploads = jest.fn(async () => ({ ok: false, motivo: 'sem_url_remota' }))
    jest.doMock('../services/inboundMediaPersistenceService', () => ({
      tipoQualificaPersistencia: () => true,
      persistInboundMediaToUploads,
    }))
    jest.doMock('../services/inboundMediaRemoteUrlRecoveryService', () => ({
      recuperarUrlRemotaDaMensagem: jest.fn(async () => null),
    }))
    const ctrl = require('../controllers/chat/inboundMediaReprocessController')
    return { ctrl, persistInboundMediaToUploads }
  }

  test('url /media/r2/<key> responde ok + ja_persistido sem recopiar nem marcar expirado', async () => {
    const { ctrl, persistInboundMediaToUploads } = montar({ url: '/media/r2/media/1/2026/10/audio/x.ogg' })
    const req = { user: { company_id: 1 }, params: { id: 3, mensagem_id: 7 }, app: { get: () => null } }
    let body = null
    let statusCode = 200
    const res = {
      status(c) { statusCode = c; return res },
      json(o) { body = o; return res },
    }

    await ctrl.reprocessarMidiaInbound(req, res)

    expect(statusCode).toBe(200)
    expect(body).toMatchObject({
      ok: true,
      ja_persistido: true,
      url: '/media/r2/media/1/2026/10/audio/x.ogg',
      status: 'concluida',
    })
    expect(body.definitivo).toBeUndefined()
    expect(persistInboundMediaToUploads).not.toHaveBeenCalled()
  })
})
