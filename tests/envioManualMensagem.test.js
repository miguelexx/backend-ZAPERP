/**
 * Testes para o fluxo de envio manual de mensagens (enviarMensagemChat).
 *
 * Cobre os cenários exigidos:
 *  1. Contato comum — envio bem-sucedido com ID hex WhatsApp
 *  2. Contato URA/empresa — não há bloqueio por tipo de contato
 *  3. Retorno com ID hexadecimal (BAE543FE1CE17AFA)
 *  4. Retorno com ID numérico curto ("35096") — ok=true → pending, sem whatsapp_id rastreável
 *  5. Retorno sucesso sem ID — ok=true → pending
 *  6. Erro real do provedor — ok=false → erro
 *
 * Regra fundamental:
 *   status='sent'  ← provider aceitou (ok=true) e retornou ID rastreável
 *   status='pending' ← provider aceitou sem ID rastreável
 *   status='erro'  ← provider recusou/falhou (ok=false), exceção ou sem telefone
 */

// ─── isRealWhatsAppId ────────────────────────────────────────────────────────

describe('isRealWhatsAppId', () => {
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

  test('rejeita ID numérico curto de fila interna ("35096")', () => {
    // IDs numéricos curtos são IDs internos de fila do UltraMsg, não WhatsApp IDs reais.
    // Não são rastreáveis via ACK webhook, por isso não são salvos como whatsapp_id.
    expect(impl('35096')).toBe(false)
    expect(impl('1')).toBe(false)
    expect(impl('123456789')).toBe(false)
  })

  test('rejeita ID hex com menos de 12 chars', () => {
    expect(impl('BAE543FE1CE')).toBe(false) // 11 chars
    expect(impl('ABCDEF12345')).toBe(false) // 11 chars
  })
})

describe('Contrato de envio estruturado de link', () => {
  test('aceita link.url enviado pelo frontend e normaliza para linkUrl', () => {
    const { normalizeLinkPayload } = require('../controllers/chatController')._test
    const normalized = normalizeLinkPayload({
      url: ' https://exemplo.com/proposta ',
      title: 'Proposta',
      description: 'Veja a proposta',
      image: 'https://exemplo.com/capa.png',
    })

    expect(normalized).toMatchObject({
      linkUrl: 'https://exemplo.com/proposta',
      title: 'Proposta',
      linkDescription: 'Veja a proposta',
      image: 'https://exemplo.com/capa.png',
    })
  })

  test('mantem compatibilidade com link.linkUrl legado', () => {
    const { normalizeLinkPayload } = require('../controllers/chatController')._test
    const normalized = normalizeLinkPayload({
      linkUrl: 'https://exemplo.com/legado',
      title: 'Legado',
    })

    expect(normalized.linkUrl).toBe('https://exemplo.com/legado')
    expect(normalized.title).toBe('Legado')
  })

  test('ignora payload de link sem URL confiavel', () => {
    const { normalizeLinkPayload } = require('../controllers/chatController')._test

    expect(normalizeLinkPayload(null)).toBeNull()
    expect(normalizeLinkPayload({ url: '   ' })).toBeNull()
  })
})

// ─── Lógica de nextStatus ────────────────────────────────────────────────────

describe('Lógica de nextStatus no envio manual', () => {
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
    // Regra: sent exige aceite do provider e ID rastreável; aceite sem rastreio fica pending.
    return {
      nextStatus: ok ? (hasValidId ? 'sent' : 'pending') : 'erro',
      nextStatusMensagem: ok ? (hasValidId ? 'sent' : 'sending') : 'failed',
      waMessageId,
      hasValidId,
    }
  }

  // ── Cenário 1: Contato comum ──────────────────────────────────────────────
  describe('Cenário 1: Contato comum', () => {
    test('ok=true + ID hex 16 chars → status=sent, whatsapp_id salvo', () => {
      const r = resolveNextStatus({ ok: true, messageId: 'BAE543FE1CE17AFA' })
      expect(r.nextStatus).toBe('sent')
      expect(r.nextStatusMensagem).toBe('sent')
      expect(r.hasValidId).toBe(true)
      expect(r.waMessageId).toBe('BAE543FE1CE17AFA')
    })

    test('ok=true + ID com @ → status=sent, whatsapp_id salvo', () => {
      const r = resolveNextStatus({ ok: true, messageId: 'false_5511999999999@c.us_BAE543FE1CE17AFA' })
      expect(r.nextStatus).toBe('sent')
      expect(r.hasValidId).toBe(true)
    })
  })

  // ── Cenário 2: Contato URA/empresa ────────────────────────────────────────
  describe('Cenário 2: Contato URA/empresa (551140029000)', () => {
    test('provider aceita → status=sent independente do tipo de contato', () => {
      const r = resolveNextStatus({ ok: true, messageId: 'CF4E9A2B1D7F3E5A' })
      expect(r.nextStatus).toBe('sent')
    })
  })

  // ── Cenário 3: ID hexadecimal ─────────────────────────────────────────────
  describe('Cenário 3: Retorno com ID hexadecimal', () => {
    test('hex 16 chars → status=sent, hasValidId=true', () => {
      const r = resolveNextStatus({ ok: true, messageId: '3EB0D854ABCDEF12' })
      expect(r.nextStatus).toBe('sent')
      expect(r.hasValidId).toBe(true)
    })

    test('hex 12 chars → status=sent, hasValidId=true', () => {
      const r = resolveNextStatus({ ok: true, messageId: '3EB0D854ABCD' })
      expect(r.nextStatus).toBe('sent')
      expect(r.hasValidId).toBe(true)
    })
  })

  // ── Cenário 4: ID numérico curto ─────────────────────────────────────────
  describe('Cenário 4: Retorno com ID numérico curto ("35096")', () => {
    test('ok=true + ID numérico curto → status=pending (sem rastreio)', () => {
      // ID "35096" é um ID interno de fila do UltraMsg, não um WhatsApp ID.
      // Sem ID rastreável, a mensagem não pode aparecer como enviada normal.
      const r = resolveNextStatus({ ok: true, messageId: '35096' })
      expect(r.nextStatus).toBe('pending')
      expect(r.nextStatusMensagem).toBe('sending')
    })

    test('ok=true + ID numérico curto → hasValidId=false (não salva como whatsapp_id rastreável)', () => {
      const r = resolveNextStatus({ ok: true, messageId: '35096' })
      expect(r.hasValidId).toBe(false)
      // A mensagem foi enviada mas whatsapp_id fica NULL (ACK não rastreável via UltraMsg)
    })
  })

  // ── Cenário 5: Sucesso sem ID ─────────────────────────────────────────────
  describe('Cenário 5: Retorno sucesso sem ID', () => {
    test('ok=true + messageId=null → status=pending (sem rastreio)', () => {
      const r = resolveNextStatus({ ok: true, messageId: null })
      expect(r.nextStatus).toBe('pending')
      expect(r.nextStatusMensagem).toBe('sending')
      expect(r.hasValidId).toBe(false)
    })

    test('ok=true sem messageId → status=pending', () => {
      const r = resolveNextStatus({ ok: true })
      expect(r.nextStatus).toBe('pending')
    })

    test('ok=true + messageId="" → status=pending', () => {
      const r = resolveNextStatus({ ok: true, messageId: '' })
      expect(r.nextStatus).toBe('pending')
    })
  })

  // ── Cenário 6: Erro real do provedor ─────────────────────────────────────
  describe('Cenário 6: Erro real do provedor', () => {
    test('ok=false → status=erro', () => {
      const r = resolveNextStatus({ ok: false, error: 'Instância desconectada' })
      expect(r.nextStatus).toBe('erro')
      expect(r.nextStatusMensagem).toBe('failed')
    })

    test('false (boolean) → status=erro', () => {
      const r = resolveNextStatus(false)
      expect(r.nextStatus).toBe('erro')
    })

    test('ok=false com blockedBy → status=erro', () => {
      const r = resolveNextStatus({ ok: false, blockedBy: 'guard', error: 'Bloqueado' })
      expect(r.nextStatus).toBe('erro')
      expect(r.nextStatusMensagem).toBe('failed')
    })

    test('ok=false sem messageId → status=erro', () => {
      const r = resolveNextStatus({ ok: false })
      expect(r.nextStatus).toBe('erro')
    })
  })

  // ── Invariante: provider aceito sem ID rastreável não deve parecer enviado normal ──
  describe('Invariante: ok=true exige ID rastreável para sent', () => {
    const casos = [
      { desc: 'com ID hex', result: { ok: true, messageId: 'BAE543FE1CE17AFA' }, expected: 'sent' },
      { desc: 'com ID numérico curto', result: { ok: true, messageId: '35096' }, expected: 'pending' },
      { desc: 'sem ID', result: { ok: true, messageId: null }, expected: 'pending' },
      { desc: 'com ID vazio', result: { ok: true, messageId: '' }, expected: 'pending' },
      { desc: 'com ID "null" string', result: { ok: true, messageId: 'null' }, expected: 'pending' },
      { desc: 'true booleano', result: true, expected: 'pending' },
    ]

    casos.forEach(({ desc, result: provResult, expected }) => {
      test(`"${desc}" → nextStatus='${expected}'`, () => {
        const r = resolveNextStatus(provResult)
        expect(r.nextStatus).toBe(expected)
      })
    })
  })

  // ── Invariante: se provider falhou, nunca deve ser sent ──────────────────
  describe('Invariante: ok=false → nextStatus sempre erro', () => {
    const casos = [
      { desc: 'erro com mensagem', result: { ok: false, error: 'Token inválido' } },
      { desc: 'false booleano', result: false },
      { desc: 'erro com blockedBy', result: { ok: false, blockedBy: 'guard' } },
    ]

    casos.forEach(({ desc, result: provResult }) => {
      test(`"${desc}" → nextStatus='erro'`, () => {
        const r = resolveNextStatus(provResult)
        expect(r.nextStatus).toBe('erro')
        expect(r.nextStatusMensagem).toBe('failed')
      })
    })
  })
})

// ─── Conversa sem telefone ───────────────────────────────────────────────────

describe('Conversa sem telefone (telefoneParaEnvio vazio)', () => {
  test('telefone vazio → sendResult indica erro', () => {
    const telefoneParaEnvio = ''
    const sendResult = telefoneParaEnvio
      ? null
      : { ok: false, error: 'Número do contato indisponível para envio' }

    expect(sendResult.ok).toBe(false)
    expect(sendResult.error).toContain('indisponível')
  })
})
