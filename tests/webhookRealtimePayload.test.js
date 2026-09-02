/**
 * Contrato de buildConversaAtualizadaPayload (controllers/webhookInbound/realtimePayload.js) — a parte
 * PURA do emit-tail de receberZapi (Fase 5, doc 24). Trava as ramificações que antes não tinham teste:
 * nome de contato, foto, grupo vs individual, fromMe, notificação discreta em atendimento e preview.
 *
 * `aplicarModoSimplesNoPayload` é mockado para devolver o payload base intacto — assim asseveramos
 * exatamente o que o builder monta, sem depender da lógica de modo simples.
 */

jest.mock('../services/atendimentoModoSimplesService', () => ({
  ...jest.requireActual('../services/atendimentoModoSimplesService'),
  aplicarModoSimplesNoPayload: jest.fn((base) => ({ ...base })),
}))

const { buildConversaAtualizadaPayload, buildNovaMensagemPayload } = require('../controllers/webhookInbound/realtimePayload')

function baseCtx(over = {}) {
  return {
    convIdForEmit: 10,
    convRow: { id: 10, status_atendimento: 'aberta', telefone: '5534999999999' },
    whatsappInstanceId: 5,
    skipChatbotPorCampanha: false,
    isGroup: false,
    depId: null,
    contatoNome: null,
    fotoPerfil: null,
    mensagemFoiInseridaPeloWebhook: true,
    fromMe: false,
    modoSimplesRecalc: null,
    emitPayload: null,
    ...over,
  }
}

describe('buildConversaAtualizadaPayload — payload de conversa_atualizada (caracterização)', () => {
  test('inbound novo (!fromMe, inserido) → tem_novas_mensagens/lida:false, badge, status e reordenar_suave', () => {
    const p = buildConversaAtualizadaPayload(baseCtx())
    expect(p.id).toBe(10)
    expect(p.whatsapp_instance_id).toBe(5)
    expect(p.exibir_badge_aberta).toBe(true)
    expect(p.status_atendimento).toBe('aberta')
    expect(p.tem_novas_mensagens).toBe(true)
    expect(p.lida).toBe(false)
    expect(p.tem_novas_mensagens_em_atendimento).toBe(false)
    expect(p.reordenar_suave).toBe(true)
  })

  test('contatoNome → grava nome_contato_cache e contato_nome; fotoPerfil → foto_perfil(_contato_cache)', () => {
    const p = buildConversaAtualizadaPayload(baseCtx({ contatoNome: 'Fulano', fotoPerfil: 'https://x/f.jpg' }))
    expect(p.nome_contato_cache).toBe('Fulano')
    expect(p.contato_nome).toBe('Fulano')
    expect(p.foto_perfil_contato_cache).toBe('https://x/f.jpg')
    expect(p.foto_perfil).toBe('https://x/f.jpg')
  })

  test('grupo → status_atendimento null e exibir_badge_aberta false', () => {
    const p = buildConversaAtualizadaPayload(baseCtx({ isGroup: true, convRow: { id: 10, status_atendimento: 'aberta' } }))
    expect(p.status_atendimento).toBeNull()
    expect(p.status_atendimento_real).toBeNull()
    expect(p.exibir_badge_aberta).toBe(false)
  })

  test('fromMe → NÃO marca tem_novas_mensagens (nós enviamos)', () => {
    const p = buildConversaAtualizadaPayload(baseCtx({ fromMe: true }))
    expect(p.tem_novas_mensagens).toBeUndefined()
    expect(p.lida).toBeUndefined()
  })

  test('em_atendimento com atendente → tem_novas_mensagens_em_atendimento (notificação discreta)', () => {
    const p = buildConversaAtualizadaPayload(baseCtx({
      convRow: { id: 10, status_atendimento: 'em_atendimento', atendente_id: 7 },
    }))
    expect(p.tem_novas_mensagens_em_atendimento).toBe(true)
  })

  test('preview: mensagem de contato → ultima_mensagem_preview com tipo/contact_meta', () => {
    const p = buildConversaAtualizadaPayload(baseCtx({
      emitPayload: { texto: 'cartão', criado_em: '2026-09-01T00:00:00Z', direcao: 'in', tipo: 'contact', contact_meta: { nome: 'Zé' } },
    }))
    expect(p.ultima_mensagem_preview).toMatchObject({ texto: 'cartão', direcao: 'in', fromMe: false, tipo: 'contact', contact_meta: { nome: 'Zé' } })
  })

  test('badge some quando status é mensagem_disparada', () => {
    const p = buildConversaAtualizadaPayload(baseCtx({ convRow: { id: 10, status_atendimento: 'mensagem_disparada' } }))
    expect(p.exibir_badge_aberta).toBe(false)
  })
})

describe('buildNovaMensagemPayload — payload de nova_mensagem (caracterização)', () => {
  const msg = { id: 9, conversa_id: 10, texto: 'oi', direcao: 'in', status: 'delivered' }

  test('status canônico, fromMe e conversa_id explícitos', () => {
    const p = buildNovaMensagemPayload({ mensagemSalva: msg, canon: 'delivered', convIdForEmit: 10, fromMe: false })
    expect(p.status).toBe('delivered')
    expect(p.status_mensagem).toBe('delivered')
    expect(p.fromMe).toBe(false)
    expect(p.conversa_id).toBe(10)
    expect(p.direcao).toBe('in')
  })

  test('direcao cai para out quando fromMe e mensagem sem direcao', () => {
    const p = buildNovaMensagemPayload({ mensagemSalva: { id: 9, conversa_id: 10 }, canon: 'sent', convIdForEmit: 10, fromMe: true })
    expect(p.direcao).toBe('out')
  })

  test('nome válido → senderName/chatName; foto http → senderPhoto/photo', () => {
    const p = buildNovaMensagemPayload({ mensagemSalva: msg, canon: 'delivered', convIdForEmit: 10, fromMe: false, senderName: 'Fulano', senderPhoto: 'https://x/a.jpg' })
    expect(p.senderName).toBe('Fulano')
    expect(p.chatName).toBe('Fulano')
    expect(p.senderPhoto).toBe('https://x/a.jpg')
    expect(p.photo).toBe('https://x/a.jpg')
  })

  test('nome que é telefone cru NÃO vira senderName; foto não-http é ignorada', () => {
    const p = buildNovaMensagemPayload({ mensagemSalva: msg, canon: 'delivered', convIdForEmit: 10, fromMe: false, nomeParaCache: '5534999999999', senderPhoto: 'file://x' })
    expect(p.senderName).toBeUndefined()
    expect(p.chatName).toBeUndefined()
    expect(p.senderPhoto).toBeUndefined()
  })
})
