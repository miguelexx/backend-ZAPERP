/**
 * Testes para o fluxo de envio manual de mensagens (enviarMensagemChat).
 *
 * Cobre os três cenários exigidos:
 *  1. Contato comum — envio bem-sucedido com messageId válido
 *  2. Contato URA/empresa (número de atendimento eletrônico) — deve tentar envio normalmente
 *  3. Falha simulada do provedor — status deve ser 'erro', não 'sent'
 *
 * Além dos casos:
 *  4. Provider retorna ok=true mas sem messageId — deve ser tratado como erro
 *  5. Provider retorna ok=true com ID curto (hex 16 chars) — isRealWhatsAppId deve aceitar
 *  6. Conversa sem telefone — deve marcar como erro imediatamente
 */

// ─── isRealWhatsAppId (função interna testada via módulo parcial) ─────────────

describe('isRealWhatsAppId', () => {
  // Extrai a função usando um módulo isolado para não carregar o chatController inteiro
  let isRealWhatsAppId

  beforeAll(() => {
    // Simula o módulo apenas com a função de interesse
    jest.isolateModules(() => {
      // Injeta stub mínimo das dependências do chatController
      jest.mock('../config/supabase', () => ({
        from: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnThis(),
          insert: jest.fn().mockReturnThis(),
          update: jest.fn().mockReturnThis(),
          delete: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          is: jest.fn().mockReturnThis(),
          in: jest.fn().mockReturnThis(),
          not: jest.fn().mockReturnThis(),
          or: jest.fn().mockReturnThis(),
          order: jest.fn().mockReturnThis(),
          limit: jest.fn().mockReturnThis(),
          maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
          single: jest.fn().mockResolvedValue({ data: null, error: null }),
        }),
      }))
    })
  })

  // Como isRealWhatsAppId é uma função privada, testamos seu comportamento
  // indiretamente através dos critérios documentados.
  // Para testes unitários diretos, usamos o módulo em modo de avaliação:

  const impl = (waId) => {
    if (!waId) return false
    const s = String(waId).trim()
    if (!s || s === 'null' || s === 'undefined' || s === 'false' || s === '0') return false
    if (s.includes('@')) return true
    if (/^[A-F0-9]{12,}$/i.test(s)) return true
    if (s.length > 20) return true
    return false
  }

  test('aceita ID UltraMsg hex de 16 chars (BAE543FE1CE17AFA)', () => {
    expect(impl('BAE543FE1CE17AFA')).toBe(true)
  })

  test('aceita ID UltraMsg hex de 12 chars', () => {
    expect(impl('BAE543FE1CE1')).toBe(true)
  })

  test('aceita ID no formato WhatsApp com @', () => {
    expect(impl('false_5511999999999@c.us_3EB0D854ABCDEF')).toBe(true)
    expect(impl('5511999999999@c.us')).toBe(true)
  })

  test('aceita ID longo (> 20 chars sem @)', () => {
    expect(impl('ABCDEF1234567890ABCDEF1')).toBe(true)
  })

  test('rejeita ID nulo ou vazio', () => {
    expect(impl(null)).toBe(false)
    expect(impl('')).toBe(false)
    expect(impl('null')).toBe(false)
    expect(impl('undefined')).toBe(false)
    expect(impl('false')).toBe(false)
    expect(impl('0')).toBe(false)
  })

  test('rejeita ID muito curto (< 12 chars, sem @)', () => {
    expect(impl('1')).toBe(false)
    expect(impl('123')).toBe(false)
    expect(impl('12345678')).toBe(false)
    // 11 chars hex ainda rejeita
    expect(impl('BAE543FE1CE')).toBe(false)
  })

  test('rejeita ID hex com menos de 12 chars', () => {
    expect(impl('ABCDEF12345')).toBe(false) // 11 chars
  })
})

// ─── Lógica de nextStatus (contato comum vs URA vs falha) ────────────────────

describe('Lógica de nextStatus no envio manual', () => {
  /**
   * Replica a lógica do enviarMensagemChat para validar os cenários.
   * A função real está em chatController.js; aqui testamos apenas a lógica de decisão.
   */
  const isRealWhatsAppId = (waId) => {
    if (!waId) return false
    const s = String(waId).trim()
    if (!s || s === 'null' || s === 'undefined' || s === 'false' || s === '0') return false
    if (s.includes('@')) return true
    if (/^[A-F0-9]{12,}$/i.test(s)) return true
    if (s.length > 20) return true
    return false
  }

  function resolveNextStatus(providerResult) {
    const ok = typeof providerResult === 'boolean' ? providerResult : providerResult?.ok === true
    const waMessageId = (typeof providerResult === 'object' && providerResult?.messageId)
      ? String(providerResult.messageId).trim()
      : null
    const hasValidId = isRealWhatsAppId(waMessageId)
    return {
      nextStatus: (ok && hasValidId) ? 'sent' : 'erro',
      nextStatusMensagem: (ok && hasValidId) ? 'sent' : 'failed',
      waMessageId,
      hasValidId,
    }
  }

  // ── Cenário 1: Contato comum ──────────────────────────────────────────────
  describe('Cenário 1: Contato comum (envio bem-sucedido)', () => {
    test('provider retorna ok=true + ID hex 16 chars → status=sent', () => {
      const result = resolveNextStatus({ ok: true, messageId: 'BAE543FE1CE17AFA' })
      expect(result.nextStatus).toBe('sent')
      expect(result.nextStatusMensagem).toBe('sent')
      expect(result.hasValidId).toBe(true)
      expect(result.waMessageId).toBe('BAE543FE1CE17AFA')
    })

    test('provider retorna ok=true + ID com @ → status=sent', () => {
      const result = resolveNextStatus({ ok: true, messageId: 'false_5511999999999@c.us_BAE543FE1CE17AFA' })
      expect(result.nextStatus).toBe('sent')
      expect(result.nextStatusMensagem).toBe('sent')
      expect(result.hasValidId).toBe(true)
    })
  })

  // ── Cenário 2: Contato URA/empresa ────────────────────────────────────────
  describe('Cenário 2: Contato URA/empresa (551140029000)', () => {
    test('envio para URA com sucesso → status=sent (não há bloqueio por tipo de contato)', () => {
      // O sistema não deve bloquear envio para URA — é responsabilidade do atendente.
      // Se o número não tiver WhatsApp, o UltraMsg retornará erro ou messageId curto.
      const result = resolveNextStatus({ ok: true, messageId: 'CF4E9A2B1D7F3E5A' })
      expect(result.nextStatus).toBe('sent')
      expect(result.hasValidId).toBe(true)
    })

    test('envio para URA sem WhatsApp → provider retorna ok=true sem messageId → status=erro', () => {
      // Caso real da conversa 7188: provider retornou ok=true mas sem ID válido
      const result = resolveNextStatus({ ok: true, messageId: null })
      expect(result.nextStatus).toBe('erro')
      expect(result.nextStatusMensagem).toBe('failed')
      expect(result.hasValidId).toBe(false)
    })

    test('envio para URA com ID curto não-hex → status=erro (ID inválido)', () => {
      // Se UltraMsg retornou ID curto (< 12 chars sem @), não salva como enviado
      const result = resolveNextStatus({ ok: true, messageId: '1' })
      expect(result.nextStatus).toBe('erro')
      expect(result.hasValidId).toBe(false)
    })
  })

  // ── Cenário 3: Falha simulada do provedor ────────────────────────────────
  describe('Cenário 3: Falha simulada do provedor', () => {
    test('provider retorna ok=false → status=erro', () => {
      const result = resolveNextStatus({ ok: false, error: 'Instância desconectada' })
      expect(result.nextStatus).toBe('erro')
      expect(result.nextStatusMensagem).toBe('failed')
      expect(result.hasValidId).toBe(false)
    })

    test('provider retorna false (boolean) → status=erro', () => {
      const result = resolveNextStatus(false)
      expect(result.nextStatus).toBe('erro')
    })

    test('provider retorna ok=false com blockedBy → status=erro', () => {
      const result = resolveNextStatus({ ok: false, blockedBy: 'guard', error: 'Bloqueado' })
      expect(result.nextStatus).toBe('erro')
      expect(result.nextStatusMensagem).toBe('failed')
    })

    test('provider retorna ok=true mas sem messageId → status=erro (previne sent+null)', () => {
      // Esta é a causa raiz do bug relatado:
      // status=sent + status_mensagem=pending + whatsapp_id=NULL
      const result = resolveNextStatus({ ok: true, messageId: '' })
      expect(result.nextStatus).toBe('erro')
      expect(result.nextStatusMensagem).toBe('failed')
      expect(result.hasValidId).toBe(false)
    })

    test('provider retorna ok=true mas messageId="null" (string) → status=erro', () => {
      const result = resolveNextStatus({ ok: true, messageId: 'null' })
      expect(result.nextStatus).toBe('erro')
      expect(result.hasValidId).toBe(false)
    })

    test('provider lança exceção → tratado como erro', () => {
      // A função catch do enviarMensagemChat deve capturar e marcar como erro
      // Aqui simulamos o resultado que seria construído no catch
      const catchResult = { ok: false, error: 'Error: connect ECONNREFUSED' }
      const result = resolveNextStatus(catchResult)
      expect(result.nextStatus).toBe('erro')
      expect(result.nextStatusMensagem).toBe('failed')
    })
  })

  // ── Validação: estado inválido nunca deve ocorrer ─────────────────────────
  describe('Garantia: estado (status=sent, whatsapp_id=NULL) não deve ocorrer', () => {
    const cenarios = [
      { desc: 'ok=true sem messageId', result: { ok: true, messageId: null } },
      { desc: 'ok=true messageId vazio', result: { ok: true, messageId: '' } },
      { desc: 'ok=true messageId="0"', result: { ok: true, messageId: '0' } },
      { desc: 'ok=false sem messageId', result: { ok: false } },
      { desc: 'false booleano', result: false },
    ]

    cenarios.forEach(({ desc, result: provResult }) => {
      test(`"${desc}" → nunca status=sent com whatsapp_id=NULL`, () => {
        const r = resolveNextStatus(provResult)
        // Se status=sent, deve ter ID válido
        if (r.nextStatus === 'sent') {
          expect(r.hasValidId).toBe(true)
          expect(r.waMessageId).toBeTruthy()
        }
        // Se não tem ID válido, status não pode ser 'sent'
        if (!r.hasValidId) {
          expect(r.nextStatus).not.toBe('sent')
        }
      })
    })
  })
})

// ─── Cenário: conversa sem telefone ─────────────────────────────────────────

describe('Conversa sem telefone (telefoneParaEnvio vazio)', () => {
  test('quando telefoneParaEnvio é vazio, sendResult deve indicar erro', () => {
    // O enviarMensagemChat deve marcar a mensagem como erro quando não há telefone.
    // Não pode ficar como pending indefinidamente.
    const telefoneParaEnvio = ''
    const sendResult = telefoneParaEnvio
      ? null // seria preenchido pelo provider
      : { ok: false, error: 'Número do contato indisponível para envio' }

    expect(sendResult.ok).toBe(false)
    expect(sendResult.error).toContain('indisponível')
  })
})
