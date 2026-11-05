/**
 * Doc 38 — "mostra enviada mas não foi": `55` colado em número estrangeiro.
 *
 * Caso real (empresa 24, conversa 42180): cliente francês `+33 780259005`. Os 11 dígitos
 * `33780259005` têm a mesma forma de um celular BR sem DDI, então `normalizePhoneBR`
 * colava `55` e o sistema passou a falar com `5533780259005` — endereço que não existe no
 * WhatsApp. A Whapi aceitava o POST, devolvia id, e a mensagem ficava `pending` para
 * sempre. Provado em produção: o MESMO PDF enviado do celular para `33780259005` ficou
 * `delivered`; a cópia do ZapERP para `5533780259005` segue `pending`.
 *
 * Estes testes travam as quatro garantias da correção:
 *   1. número brasileiro NÃO muda de resultado em lugar nenhum;
 *   2. 11 dígitos que não podem ser BR saem intactos (leitura e envio);
 *   3. a busca ainda acha o que foi gravado com o `55` indevido (sem duplicar conversa);
 *   4. a forma legada nunca colide com o número de outra pessoa.
 */

const {
  normalizePhoneBR,
  toZapiSendFormat,
  preferredBrSendDigits,
  possiblePhonesBR,
  possiblePhonesForWhatsappIdentity,
  podeSerCelularBrSemDdi,
  formaLegadaCom55,
} = require('../helpers/phoneHelper')

const { recipientCandidates, toWhapiChatId } = require('../services/providers/whapi/phones')

/** Implementação anterior à correção do doc 38 — referência do diferencial. */
function normalizePhoneBRAntesDoDoc38(phone) {
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

/** Classe que a correção muda de propósito. */
function ehEnderecoInternacionalDe11(valor) {
  const d = String(valor || '').replace(/\D/g, '')
  return d.length === 11 && !d.startsWith('0') && !podeSerCelularBrSemDdi(d)
}

function corpusAleatorio() {
  const corpus = []
  for (let len = 1; len <= 20; len += 1) {
    for (let i = 0; i < 400; i += 1) {
      let s = ''
      for (let k = 0; k < len; k += 1) s += Math.floor(Math.random() * 10)
      corpus.push(s)
    }
  }
  return corpus
}

describe('doc 38 — endereço internacional não recebe `55`', () => {
  describe('o caso real (Lucas Oliveira, +33 780259005)', () => {
    test('leitura, envio e chat id usam o endereço verdadeiro', () => {
      expect(normalizePhoneBR('33780259005')).toBe('33780259005')
      expect(normalizePhoneBR('33780259005@s.whatsapp.net')).toBe('33780259005')
      expect(toZapiSendFormat('33780259005')).toBe('33780259005')
      // preferredBrSendDigits só fala de número BR: devolve vazio e o chamador usa o cru.
      expect(preferredBrSendDigits('33780259005')).toBe('')
      expect(recipientCandidates('33780259005')).toEqual(['33780259005'])
      expect(toWhapiChatId('33780259005')).toBe('33780259005@s.whatsapp.net')
    })

    test('antes da correção o destino era outro (regressão que não pode voltar)', () => {
      expect(normalizePhoneBRAntesDoDoc38('33780259005')).toBe('5533780259005')
      expect(normalizePhoneBR('33780259005')).not.toBe('5533780259005')
    })
  })

  describe('outros DDIs que caíam na mesma armadilha', () => {
    const casos = [
      ['14152223333', 'EUA +1 415 222 3333'],
      ['34612345678', 'Espanha +34 612345678'],
      ['56912345678', 'Chile +56 9 1234 5678'],
      ['31612345678', 'Holanda +31 612345678'],
    ]
    test.each(casos)('%s (%s) sai intacto', (numero) => {
      expect(normalizePhoneBR(numero)).toBe(numero)
      expect(toZapiSendFormat(numero)).toBe(numero)
    })
  })

  describe('número brasileiro não muda de resultado', () => {
    const brasileiros = [
      '34999999999',     // celular sem DDI
      '11987654321',     // celular SP sem DDI
      '3499999999',      // 10 dígitos (celular antigo, sem o 9)
      '1140041234',      // 10 dígitos (fixo SP)
      '553499999999',    // 12 dígitos
      '5534999999999',   // 13 dígitos
      '553484217473',    // 12 dígitos, contato real
      '03499826551',     // tronco "0" com 11 dígitos — caminho do doc 39, intocado
      '+55 34 99826-5514',
      '120363045123456789@g.us',
    ]

    test.each(brasileiros)('%s passa igual pelas três funções', (numero) => {
      expect(normalizePhoneBR(numero)).toBe(normalizePhoneBRAntesDoDoc38(numero))
      expect(toZapiSendFormat(numero)).toBe(toZapiSendFormatAntesDoDoc38(numero))
    })

    test('todo celular BR de 11 dígitos continua ganhando o `55`', () => {
      const ddds = ['11', '21', '34', '47', '62', '71', '85', '91', '99']
      for (const ddd of ddds) {
        for (let i = 0; i < 50; i += 1) {
          let resto = ''
          for (let k = 0; k < 8; k += 1) resto += Math.floor(Math.random() * 10)
          const numero = `${ddd}9${resto}`
          expect(podeSerCelularBrSemDdi(numero)).toBe(true)
          expect(normalizePhoneBR(numero)).toBe('55' + numero)
        }
      }
    })
  })

  describe('diferencial velho × novo', () => {
    test('só a classe de 11 dígitos não-BR muda, e nenhuma entrada passa a ser recusada', () => {
      const corpus = corpusAleatorio()
      const mudancasInesperadas = []
      const recusasNovas = []

      for (const v of corpus) {
        const antes = normalizePhoneBRAntesDoDoc38(v)
        const depois = normalizePhoneBR(v)
        if (antes !== '' && depois === '') recusasNovas.push(v)
        if (antes === depois) continue
        if (ehEnderecoInternacionalDe11(v)) {
          expect(depois).toBe(String(v).replace(/\D/g, ''))
          continue
        }
        if (antes !== '') mudancasInesperadas.push({ v, antes, depois })
      }

      expect(mudancasInesperadas).toEqual([])
      expect(recusasNovas).toEqual([])
    })
  })

  describe('busca não duplica conversa do passivo', () => {
    test('as variantes incluem a forma legada com `55`', () => {
      expect(possiblePhonesBR('33780259005')).toEqual(
        expect.arrayContaining(['33780259005', '5533780259005'])
      )
      expect(possiblePhonesForWhatsappIdentity('33780259005')).toEqual(
        expect.arrayContaining(['33780259005', '5533780259005'])
      )
    })

    test('número BR não ganha variante legada nova', () => {
      expect(possiblePhonesBR('34999999999')).toEqual(['5534999999999', '553499999999'])
      expect(formaLegadaCom55('34999999999')).toBe('')
      expect(formaLegadaCom55('03499826551')).toBe('')
      expect(formaLegadaCom55('5534999999999')).toBe('')
    })

    test('a forma legada nunca é o número de outra pessoa', () => {
      // `55` + X só seria um BR de verdade se X fosse celular BR — e esse caso não entra aqui.
      const corpus = corpusAleatorio().filter(ehEnderecoInternacionalDe11)
      expect(corpus.length).toBeGreaterThan(0)
      for (const v of corpus) {
        const legada = formaLegadaCom55(v)
        expect(legada).toBe('55' + v)
        // 13 dígitos cujo 5º não é `9` não existe como celular brasileiro.
        expect(legada.length).toBe(13)
        expect(podeSerCelularBrSemDdi(legada.slice(2))).toBe(false)
      }
    })
  })
})

/** Mesma referência, para toZapiSendFormat. */
function toZapiSendFormatAntesDoDoc38(phone) {
  const s = String(phone || '').trim()
  if (s.endsWith('@g.us')) return s
  const digits = s.replace(/\D/g, '')
  if (!digits) return ''
  if (digits.startsWith('120') && digits.length >= 15 && digits.length <= 22) return digits
  if (digits.length === 10 || digits.length === 11) return '55' + digits
  if (!digits.startsWith('55') || digits.length < 12) return ''
  if (digits.length === 13) return digits
  if (digits.length === 12) {
    const ddd = digits.slice(2, 4)
    const rest = digits.slice(4)
    return '55' + ddd + '9' + rest
  }
  return ''
}
