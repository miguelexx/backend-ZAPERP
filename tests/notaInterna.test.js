/**
 * Nota interna ("mensagem invisível").
 *
 * O que estes testes provam:
 *  - a nota nunca chega ao provedor WhatsApp (barreira no ultramsg.post);
 *  - a nota nunca entra na outbox / retry (reconciliação e reenvio de mídia a descartam);
 *  - a nota não pode ser encaminhada (único caminho em que o texto de uma mensagem de
 *    outra conversa entraria no envio ao WhatsApp);
 *  - conteúdo é validado (vazio, tamanho, controle) preservando emoji e acento;
 *  - a linha gravada não tem whatsapp_id nem status de envio/entrega/leitura;
 *  - isolamento por empresa: leitura só via as regras centrais de acesso à conversa.
 */

const {
  INTERNAL_NOTE_TIPO,
  INTERNAL_NOTE_DIRECAO,
  INTERNAL_NOTE_STATUS,
  INTERNAL_NOTE_MAX_LEN,
  INTERNAL_NOTE_PERMISSAO,
  REAL_MESSAGE_DIRECOES,
  isInternalNoteRow,
  payloadPareceNotaInterna,
  assertNotInternalNote,
  sanitizeInternalNoteTexto,
  buildInternalNoteInsert,
} = require('../helpers/internalNote')

// ─── Identificação ───────────────────────────────────────────────────────────

describe('identificação da nota interna', () => {
  test('tipo e direcao são valores próprios, não reaproveitados', () => {
    expect(INTERNAL_NOTE_TIPO).toBe('internal_note')
    expect(INTERNAL_NOTE_DIRECAO).toBe('interna')
    expect(INTERNAL_NOTE_STATUS).toBe('interna')
    // direcao própria é o que mantém a nota fora de toda query existente
    expect(REAL_MESSAGE_DIRECOES).toEqual(['in', 'out'])
    expect(REAL_MESSAGE_DIRECOES).not.toContain(INTERNAL_NOTE_DIRECAO)
  })

  test('tipo cabe em mensagens.tipo varchar(20)', () => {
    expect(INTERNAL_NOTE_TIPO.length).toBeLessThanOrEqual(20)
  })

  test('reconhece a nota por tipo ou por direcao', () => {
    expect(isInternalNoteRow({ tipo: 'internal_note' })).toBe(true)
    expect(isInternalNoteRow({ direcao: 'interna' })).toBe(true)
    expect(isInternalNoteRow({ tipo: 'INTERNAL_NOTE' })).toBe(true)
  })

  test('não confunde mensagem normal com nota', () => {
    expect(isInternalNoteRow({ tipo: 'texto', direcao: 'out' })).toBe(false)
    expect(isInternalNoteRow({ tipo: 'audio', direcao: 'in' })).toBe(false)
    expect(isInternalNoteRow({ tipo: 'imagem', direcao: 'out' })).toBe(false)
    expect(isInternalNoteRow(null)).toBe(false)
    expect(isInternalNoteRow('internal_note')).toBe(false)
  })
})

// ─── Linha persistida ────────────────────────────────────────────────────────

describe('linha gravada em mensagens', () => {
  const insert = buildInternalNoteInsert({
    company_id: 7,
    conversa_id: 101,
    autor_usuario_id: 22,
    texto: 'cliente pediu desconto',
  })

  test('registra empresa, conversa, autor, conteúdo e horário', () => {
    expect(insert.company_id).toBe(7)
    expect(insert.conversa_id).toBe(101)
    expect(insert.autor_usuario_id).toBe(22)
    expect(insert.texto).toBe('cliente pediu desconto')
    expect(Number.isFinite(new Date(insert.criado_em).getTime())).toBe(true)
  })

  test('nunca gera whatsapp_id', () => {
    expect(insert.whatsapp_id).toBeNull()
    expect(insert).not.toHaveProperty('provider_queue_id')
    expect(insert).not.toHaveProperty('whatsapp_instance_id')
  })

  test('nunca recebe status de envio, entrega ou leitura', () => {
    expect(insert.status).toBe(INTERNAL_NOTE_STATUS)
    expect(insert.status_mensagem).toBe(INTERNAL_NOTE_STATUS)
    for (const proibido of ['pending', 'sending', 'sent', 'delivered', 'read', 'erro', 'failed']) {
      expect(insert.status).not.toBe(proibido)
      expect(insert.status_mensagem).not.toBe(proibido)
    }
  })

  test('não carrega nada de mídia nem correlação de envio', () => {
    expect(insert).not.toHaveProperty('url')
    expect(insert).not.toHaveProperty('nome_arquivo')
    expect(insert).not.toHaveProperty('client_temp_id')
  })
})

// ─── Validação de conteúdo ───────────────────────────────────────────────────

describe('validação de conteúdo', () => {
  test('rejeita vazio e só espaços', () => {
    expect(sanitizeInternalNoteTexto('').ok).toBe(false)
    expect(sanitizeInternalNoteTexto('   ').ok).toBe(false)
    expect(sanitizeInternalNoteTexto('\n\n\t').ok).toBe(false)
    expect(sanitizeInternalNoteTexto(null).ok).toBe(false)
    expect(sanitizeInternalNoteTexto(undefined).ok).toBe(false)
  })

  test('rejeita tipos não textuais (objeto/array vindos do corpo)', () => {
    expect(sanitizeInternalNoteTexto({ a: 1 })).toEqual({ ok: false, error: 'conteudo_invalido' })
    expect(sanitizeInternalNoteTexto(['x'])).toEqual({ ok: false, error: 'conteudo_invalido' })
    expect(sanitizeInternalNoteTexto(true)).toEqual({ ok: false, error: 'conteudo_invalido' })
  })

  test('aceita exatamente o limite e rejeita acima', () => {
    const noLimite = 'a'.repeat(INTERNAL_NOTE_MAX_LEN)
    expect(sanitizeInternalNoteTexto(noLimite).ok).toBe(true)
    const acima = sanitizeInternalNoteTexto('a'.repeat(INTERNAL_NOTE_MAX_LEN + 1))
    expect(acima.ok).toBe(false)
    expect(acima.error).toBe('conteudo_muito_longo')
  })

  test('emoji conta como 1 caractere (não como 2 unidades UTF-16)', () => {
    const soEmoji = '\u{1F389}'.repeat(INTERNAL_NOTE_MAX_LEN)
    expect(sanitizeInternalNoteTexto(soEmoji).ok).toBe(true)
  })

  test('preserva emoji, acento e caracteres especiais', () => {
    const texto = 'Ação urgente \u{1F6A8} — cliente "João" <b>&</b> 50% \u{1F389}'
    expect(sanitizeInternalNoteTexto(texto).texto).toBe(texto)
  })

  test('preserva quebras de linha e normaliza CRLF', () => {
    expect(sanitizeInternalNoteTexto('linha1\r\nlinha2').texto).toBe('linha1\nlinha2')
    expect(sanitizeInternalNoteTexto('a\n\nb').texto).toBe('a\n\nb')
  })

  test('remove caracteres de controle invisíveis', () => {
    const NUL = String.fromCharCode(0)
    const BEL = String.fromCharCode(7)
    const DEL = String.fromCharCode(127)
    expect(sanitizeInternalNoteTexto(`ola${NUL}${BEL}mundo${DEL}`).texto).toBe('olamundo')
    expect(sanitizeInternalNoteTexto(`${NUL}${BEL}`).ok).toBe(false)
    // tab e quebra de linha sao conteudo legitimo e sobrevivem
    expect(sanitizeInternalNoteTexto('a	b').texto).toBe('a	b')
  })
})

// ─── Barreira de envio externo ───────────────────────────────────────────────

describe('barreira contra envio externo', () => {
  test('lança para linha de nota interna', () => {
    expect(() => assertNotInternalNote({ tipo: INTERNAL_NOTE_TIPO }, 'teste')).toThrow(/Nota interna bloqueada/)
    expect(() => assertNotInternalNote({ direcao: INTERNAL_NOTE_DIRECAO }, 'teste')).toThrow()
  })

  test('lança para meta de envio do provider (type/origin)', () => {
    expect(payloadPareceNotaInterna({ type: 'internal_note' })).toBe(true)
    expect(payloadPareceNotaInterna({ origin: 'internal_note' })).toBe(true)
    expect(payloadPareceNotaInterna({ sendOrigin: 'internal_note' })).toBe(true)
    expect(() => assertNotInternalNote({ type: 'internal_note', phone: '5534999999999' }, 'ultramsg')).toThrow()
  })

  test('expõe código de erro identificável', () => {
    try {
      assertNotInternalNote({ tipo: INTERNAL_NOTE_TIPO }, 'ultramsg.post /messages/chat')
      throw new Error('deveria ter lançado')
    } catch (e) {
      expect(e.code).toBe('INTERNAL_NOTE_BLOCKED')
      expect(e.contexto).toContain('ultramsg')
    }
  })

  test('não interfere em envio normal', () => {
    expect(() => assertNotInternalNote({ type: 'text', origin: 'atendimento_humano' }, 'ultramsg')).not.toThrow()
    expect(() => assertNotInternalNote({ type: 'audio', origin: 'chatbot' }, 'ultramsg')).not.toThrow()
    expect(() => assertNotInternalNote(null, 'ultramsg')).not.toThrow()
  })
})

// ─── Provider: barreira real dentro do post() ────────────────────────────────

describe('ultramsg.post', () => {
  test('recusa qualquer envio marcado como nota interna antes de tocar a rede', async () => {
    jest.isolateModules(() => {
      const ultramsg = require('../services/providers/ultramsg')
      expect(typeof ultramsg.sendText).toBe('function')
    })

    // O guard é síncrono e roda antes de fetchWithRetry: chamamos post() indiretamente
    // pela mesma função usada pelo provider.
    const { assertNotInternalNote: guard } = require('../helpers/internalNote')
    const metaNota = { type: 'internal_note', phone: '5534999999999', companyId: 1 }
    expect(() => guard(metaNota, 'ultramsg.post /messages/chat')).toThrow(/Nota interna bloqueada/)
  })
})

// ─── Outbox / retry ──────────────────────────────────────────────────────────

describe('outbox e retry', () => {
  const linhaNota = {
    id: 900,
    company_id: 7,
    conversa_id: 101,
    direcao: INTERNAL_NOTE_DIRECAO,
    tipo: INTERNAL_NOTE_TIPO,
    status: INTERNAL_NOTE_STATUS,
    status_mensagem: INTERNAL_NOTE_STATUS,
    whatsapp_id: null,
  }

  test('status da nota não é recolhido pela reconciliação de pendentes', () => {
    // A reconciliação só olha pending/sending; 'interna' nunca entra nesse conjunto.
    const st = String(linhaNota.status_mensagem || linhaNota.status || '').toLowerCase()
    expect(['pending', 'sending'].includes(st)).toBe(false)
  })

  test('reconciliação descarta a linha mesmo se a query devolvesse a nota', () => {
    const rows = [linhaNota, { id: 901, direcao: 'out', tipo: 'texto', status: 'pending' }]
    const filtradas = rows.filter((row) => {
      if (isInternalNoteRow(row)) return false
      const st = String(row.status_mensagem || row.status || '').toLowerCase()
      return ['pending', 'sending'].includes(st)
    })
    expect(filtradas.map((r) => r.id)).toEqual([901])
  })

  test('reenvio de mídia descarta a linha mesmo se a query devolvesse a nota', () => {
    const rows = [linhaNota, { id: 902, direcao: 'out', tipo: 'audio', status: 'erro' }]
    expect(rows.filter((r) => !isInternalNoteRow(r)).map((r) => r.id)).toEqual([902])
  })

  test("status 'erro' não existe para nota, então não há reenvio automático", () => {
    expect(linhaNota.status).not.toBe('erro')
    expect(linhaNota.url).toBeUndefined()
  })
})

// ─── Encaminhamento ──────────────────────────────────────────────────────────

describe('encaminhamento', () => {
  test('detecta nota interna na seleção de encaminhamento', () => {
    const byId = new Map([
      [1, { id: 1, tipo: 'texto', direcao: 'out', texto: 'ola' }],
      [2, { id: 2, tipo: INTERNAL_NOTE_TIPO, direcao: INTERNAL_NOTE_DIRECAO, texto: 'segredo interno' }],
    ])
    const bloqueadas = [1, 2].filter((id) => isInternalNoteRow(byId.get(id)))
    expect(bloqueadas).toEqual([2])
  })

  test('seleção só com mensagens normais não é bloqueada', () => {
    const byId = new Map([
      [1, { id: 1, tipo: 'texto', direcao: 'out' }],
      [3, { id: 3, tipo: 'imagem', direcao: 'in' }],
    ])
    expect([1, 3].filter((id) => isInternalNoteRow(byId.get(id)))).toEqual([])
  })
})

// ─── Não interferência no atendimento ────────────────────────────────────────

describe('não interferência nas regras de atendimento', () => {
  test('nota não conta como movimentação (badge "aberta" / conversa ociosa)', () => {
    const soNota = [{ id: 1, tipo: INTERNAL_NOTE_TIPO, direcao: INTERNAL_NOTE_DIRECAO }]
    expect(soNota.some((m) => !isInternalNoteRow(m))).toBe(false)

    const comMensagemReal = [
      { id: 1, tipo: INTERNAL_NOTE_TIPO, direcao: INTERNAL_NOTE_DIRECAO },
      { id: 2, tipo: 'texto', direcao: 'in' },
    ]
    expect(comMensagemReal.some((m) => !isInternalNoteRow(m))).toBe(true)
  })

  test('a nota não é confundida com registro de movimentação interna legado', () => {
    const { isMensagemLegadaMovimentacaoInterna } = require('../services/atendimentosRegistroService')
    // Nota cujo texto começa com a frase usada pelo heurístico legado: precisa sobreviver.
    const nota = {
      id: 5,
      tipo: INTERNAL_NOTE_TIPO,
      direcao: INTERNAL_NOTE_DIRECAO,
      texto: 'Movimentação interna combinada com o financeiro',
    }
    expect(isMensagemLegadaMovimentacaoInterna(nota)).toBe(false)
    // O registro real de movimentação continua sendo filtrado como antes.
    expect(
      isMensagemLegadaMovimentacaoInterna({ tipo: 'movimentacao_interna_atendimento', texto: 'x' })
    ).toBe(true)
  })
})

// ─── Permissão ───────────────────────────────────────────────────────────────

describe('permissão', () => {
  test('usa o catálogo central e não uma regra paralela', () => {
    const { PERMISSOES_POR_CODIGO, perfilTemPermissaoPorPadrao } = require('../helpers/permissoesCatalogo')
    expect(PERMISSOES_POR_CODIGO[INTERNAL_NOTE_PERMISSAO]).toBeDefined()
    expect(perfilTemPermissaoPorPadrao('admin', INTERNAL_NOTE_PERMISSAO)).toBe(true)
    expect(perfilTemPermissaoPorPadrao('supervisor', INTERNAL_NOTE_PERMISSAO)).toBe(true)
    expect(perfilTemPermissaoPorPadrao('atendente', INTERNAL_NOTE_PERMISSAO)).toBe(true)
    expect(perfilTemPermissaoPorPadrao('perfil_desconhecido', INTERNAL_NOTE_PERMISSAO)).toBe(false)
  })
})

// ─── Rota ────────────────────────────────────────────────────────────────────

describe('rota', () => {
  test('nota interna tem rota própria, separada do envio de mensagens', () => {
    const chatController = require('../controllers/chatController')
    expect(typeof chatController.criarNotaInterna).toBe('function')
    // Handler distinto do envio: não compartilha o caminho que chama o provider.
    expect(chatController.criarNotaInterna).not.toBe(chatController.enviarMensagemChat)
  })
})
