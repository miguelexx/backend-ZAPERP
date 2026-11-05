/**
 * Doc 39 — contato que aparecia na busca ("Sem conversa") e estourava 500 ao abrir.
 *
 * Causa: telefone gravado com tronco "0" antes do DDD (hábito de agenda: "034 99826-5514",
 * "+55 (034) 9826-5514"). A importação aceitava 10–15 dígitos quaisquer; abrir a conversa
 * exigia padrão BR. Resultado: contato impossível de abrir.
 *
 * Estes testes travam as três garantias da correção:
 *   1. a recuperação do tronco NÃO muda nenhum número que já era aceito;
 *   2. a agenda passa a importar o número certo;
 *   3. telefone inválido devolve erro de DADO (400 + código), não 500.
 */

const {
  normalizePhoneBR,
  normalizePhoneBRParaCadastro,
  corrigirTroncoZeroBR,
  podeSerCelularBrSemDdi,
} = require('../helpers/phoneHelper')

/** Implementação anterior à correção — referência para provar ausência de regressão. */
function normalizePhoneBRAntesDaCorrecao(phone) {
  const s = String(phone || '').trim()
  if (!s) return ''
  if (s.endsWith('@g.us')) return s
  const digits = s.replace(/\D/g, '')
  if (!digits) return ''
  if (digits.startsWith('120') && digits.length >= 15 && digits.length <= 22) return digits
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) return digits
  if (digits.length === 10 || digits.length === 11) return '55' + digits
  return ''
}

describe('doc 39 — tronco "0" antes do DDD', () => {
  describe('normalizePhoneBR (caminho de LEITURA)', () => {
    test('nenhum número hoje aceito muda de resultado', () => {
      const corpus = []
      for (let len = 1; len <= 20; len += 1) {
        for (let i = 0; i < 300; i += 1) {
          let s = ''
          for (let k = 0; k < len; k += 1) s += Math.floor(Math.random() * 10)
          corpus.push(s)
        }
      }
      corpus.push(
        '5534998265514',
        '553498265514',
        '34998265514',
        '3498265514',
        '120363045123456789@g.us',
        '+55 34 99826-5514',
        ''
      )

      const regressoes = corpus.filter((v) => {
        const antes = normalizePhoneBRAntesDaCorrecao(v)
        if (antes === '') return false
        // Mudança DELIBERADA do doc 38, posterior a este teste: 11 dígitos que não podem
        // ser celular BR (DDD válido + nono dígito) são endereço internacional e não levam
        // mais o `55`. A classe inteira tem teste próprio, com diferencial velho × novo,
        // em tests/enderecoInternacionalSemDdi55.test.js.
        const digits = String(v || '').replace(/\D/g, '')
        if (digits.length === 11 && !digits.startsWith('0') && !podeSerCelularBrSemDdi(digits)) return false
        return antes !== normalizePhoneBR(v)
      })

      expect(regressoes).toEqual([])
    })

    test('recupera o tronco só quando o resultado é um número BR válido', () => {
      expect(normalizePhoneBR('034 99826-5514')).toBe('5534998265514')
      expect(normalizePhoneBR('+55 (034) 99826-5514')).toBe('5534998265514')
      // Código de operadora ("0 41 34 …") é ambíguo: continua recusado.
      expect(normalizePhoneBR('0 41 34 9982-6551')).toBe('')
      // Internacional não vira número BR.
      expect(normalizePhoneBR('+351 912345678')).toBe('')
    })

    test('nunca devolve DDD começando com 0 pelo ramo de recuperação', () => {
      for (let i = 0; i < 5000; i += 1) {
        const len = 11 + (i % 5)
        let s = '0'
        for (let k = 1; k < len; k += 1) s += Math.floor(Math.random() * 10)
        const out = normalizePhoneBR(s)
        if (out && normalizePhoneBRAntesDaCorrecao(s) === '') {
          expect(out).toMatch(/^55[1-9]\d{9,10}$/)
        }
      }
    })
  })

  describe('normalizePhoneBRParaCadastro (caminho de ESCRITA)', () => {
    test('corrige também o tronco que a regra BR strict aceitava intacto', () => {
      // 11 dígitos "0" + DDD: a regra de 10/11 dígitos gerava "5503498265514" (DDD 03).
      expect(normalizePhoneBRAntesDaCorrecao('(034) 9826-5514')).toBe('5503498265514')
      expect(normalizePhoneBRParaCadastro('(034) 9826-5514')).toBe('553498265514')
      // 13 dígitos "55" + "0" + DDD: idem, aceito intacto pela regra BR strict.
      expect(normalizePhoneBRParaCadastro('+55 (034) 9826-5514')).toBe('553498265514')
    })

    test('número já correto passa idêntico pelas duas funções', () => {
      for (const v of ['5534998265514', '553498265514', '34998265514', '3498265514', '+55 34 99826-5514']) {
        expect(normalizePhoneBRParaCadastro(v)).toBe(normalizePhoneBR(v))
      }
    })
  })

  describe('corrigirTroncoZeroBR', () => {
    test('devolve vazio quando o fluxo normal já resolve', () => {
      const jaResolvidos = [
        '5534998265514',
        '34998265514',
        '+55 34 99826-5514',
        '+351 912345678',
        '',
        // o ramo de recuperação de `normalizePhoneBR` já devolve estes corretamente
        '034 99826-5514',
        '+55 (034) 99826-5514',
      ]
      for (const v of jaResolvidos) {
        expect(corrigirTroncoZeroBR(v)).toBe('')
      }
    })

    test('devolve o número corrigido só onde a regra BR strict erraria', () => {
      expect(corrigirTroncoZeroBR('(034) 9826-5514')).toBe('553498265514')
      expect(corrigirTroncoZeroBR('+55 (034) 9826-5514')).toBe('553498265514')
    })

    test('o uso `corrigido || entrada` leva ao número certo nos dois casos', () => {
      const comoOsControllersUsam = (entrada) => {
        const telefone = corrigirTroncoZeroBR(entrada) || entrada
        return normalizePhoneBR(telefone)
      }
      expect(comoOsControllersUsam('(034) 9826-5514')).toBe('553498265514')
      expect(comoOsControllersUsam('034 99826-5514')).toBe('5534998265514')
      expect(comoOsControllersUsam('+55 34 99826-5514')).toBe('5534998265514')
      expect(comoOsControllersUsam('34998265514')).toBe('5534998265514')
    })
  })

  describe('importação da agenda', () => {
    // `tests/setup.js` já substitui `config/supabase` por um mock global — nada de env aqui:
    // a suíte roda com `--runInBand`, então escrever em `process.env` vazaria para os outros
    // arquivos de teste do mesmo processo.
    beforeEach(() => {
      jest.resetModules()
    })

    test('contato salvo com 0 no DDD entra como número BR, não como internacional', () => {
      const { parseAgendaContact } = require('../services/contactSyncService')

      const comNove = parseAgendaContact({ name: 'Contato Agenda', id: '034 99826-5514' })
      expect(comNove).toMatchObject({ phone: '5534998265514', isBR: true })

      const semNove = parseAgendaContact({ name: 'Contato Agenda', id: '(034) 9826-5514' })
      expect(semNove).toMatchObject({ phone: '553498265514', isBR: true })

      const comDdi = parseAgendaContact({ name: 'Contato Agenda', id: '+55 (034) 99826-5514' })
      expect(comDdi).toMatchObject({ phone: '5534998265514', isBR: true })
    })

    test('contato que já vinha certo continua idêntico', () => {
      const { parseAgendaContact } = require('../services/contactSyncService')
      expect(parseAgendaContact({ name: 'Ok', id: '5534998265514@c.us' })).toMatchObject({
        phone: '5534998265514',
        isBR: true,
      })
      expect(parseAgendaContact({ name: 'Ok', id: '34998265514' })).toMatchObject({
        phone: '5534998265514',
        isBR: true,
      })
    })
  })

  describe('abrir conversa com telefone impossível', () => {
    beforeEach(() => {
      jest.resetModules()
    })

    test('devolve código de erro de DADO em vez de falha genérica', async () => {
      jest.doMock('../config/supabase', () => ({ from: () => ({}) }))
      jest.doMock('../services/whatsappInstanceService', () => ({
        resolveWhatsappInstanceForManualAction: jest.fn(async () => ({
          error: null,
          code: null,
          instanceId: 8,
          isDefault: false,
          instance: { id: 8, nome: 'WhatsApp Teste' },
          instances: [],
        })),
        sanitizeWhatsappInstance: (i) => i,
      }))
      // Telefone que não normaliza → findOrCreateConversation devolve null (sem exceção).
      jest.doMock('../helpers/conversationSync', () => ({
        findOrCreateConversation: jest.fn(async () => null),
      }))

      const { ensureConversaForCliente } = require('../services/conversaAbrirClienteService')
      const r = await ensureConversaForCliente({
        company_id: 1,
        usuario_id: 99,
        cliente: { id: 5, nome: 'Contato', telefone: '351912345678' },
        whatsapp_instance_id: 8,
      })

      expect(r.ok).toBe(false)
      expect(r.codigo).toBe('TELEFONE_CONTATO_INVALIDO')
      expect(r.error).toMatch(/não é válido para WhatsApp/i)
      expect(r.conversa).toBeNull()
    })
  })
})
