const {
  aggregateResponseStats,
  outboundEhRespostaHumana,
} = require('../services/supervisaoService')

// Config de triagem/ausência determinística (sem depender de heurística de bot):
const triage = {
  triageMerged: {},
  absence: { mensagem: 'Estamos ausentes no momento.' },
}

describe('supervisaoService — tempo médio de resposta (certificação)', () => {
  describe('outboundEhRespostaHumana', () => {
    it('conta outbound de atendente com autor real', () => {
      expect(
        outboundEhRespostaHumana({ direcao: 'out', autor_usuario_id: 7, texto: 'Olá!' }, triage)
      ).toBe(true)
    })

    it('NÃO conta mensagem de ausência (mesmo com autor)', () => {
      expect(
        outboundEhRespostaHumana(
          { direcao: 'out', autor_usuario_id: 5, texto: 'Estamos ausentes no momento.' },
          triage
        )
      ).toBe(false)
    })

    it('NÃO conta inbound', () => {
      expect(outboundEhRespostaHumana({ direcao: 'in', texto: 'oi' }, triage)).toBe(false)
    })

    it('fallback sem triage conta como humana (não zera médias)', () => {
      expect(
        outboundEhRespostaHumana({ direcao: 'out', autor_usuario_id: null, texto: 'x' }, null)
      ).toBe(true)
    })
  })

  describe('aggregateResponseStats', () => {
    it('exclui bot/ausência, credita o autor REAL e calcula médias', () => {
      const rows = [
        // Conversa 1: ausência (autor null) não fecha o ciclo; humano do autor 7 fecha em 5 min
        { conversa_id: 1, direcao: 'in', criado_em: '2026-08-12T10:00:00Z' },
        { conversa_id: 1, direcao: 'out', criado_em: '2026-08-12T10:02:00Z', autor_usuario_id: null, texto: 'Estamos ausentes no momento.' },
        { conversa_id: 1, direcao: 'out', criado_em: '2026-08-12T10:05:00Z', autor_usuario_id: 7, texto: 'Olá, como posso ajudar?' },
        // Conversa 2: respondida pelo autor 9 em 10 min
        { conversa_id: 2, direcao: 'in', criado_em: '2026-08-12T09:00:00Z' },
        { conversa_id: 2, direcao: 'out', criado_em: '2026-08-12T09:10:00Z', autor_usuario_id: 9, texto: 'Resolvido' },
        // Conversa 3: só mensagem de ausência (autor 5) — não gera par
        { conversa_id: 3, direcao: 'in', criado_em: '2026-08-12T08:00:00Z' },
        { conversa_id: 3, direcao: 'out', criado_em: '2026-08-12T08:03:00Z', autor_usuario_id: 5, texto: 'Estamos ausentes no momento.' },
      ]

      const stats = aggregateResponseStats(rows, triage)

      // Atribuição ao autor real da resposta:
      expect(stats.byAuthor.get(7)).toBe(5)
      expect(stats.byAuthor.get(9)).toBe(10)
      // Autor 5 só mandou ausência → não pontua:
      expect(stats.byAuthor.has(5)).toBe(false)
      // Média por conversa:
      expect(stats.byConversation.get(1)).toBe(5)
      expect(stats.byConversation.get(2)).toBe(10)
      expect(stats.byConversation.has(3)).toBe(false)
      // Média global de todos os pares:
      expect(stats.globalAverage).toBe(7.5)
    })

    it('rajada do cliente: pareia a 1ª pendente com a 1ª resposta humana', () => {
      const rows = [
        { conversa_id: 10, direcao: 'in', criado_em: '2026-08-12T12:00:00Z' },
        { conversa_id: 10, direcao: 'in', criado_em: '2026-08-12T12:01:00Z' },
        { conversa_id: 10, direcao: 'in', criado_em: '2026-08-12T12:02:00Z' },
        { conversa_id: 10, direcao: 'out', criado_em: '2026-08-12T12:08:00Z', autor_usuario_id: 3, texto: 'Oi' },
      ]
      const stats = aggregateResponseStats(rows, triage)
      // 8 minutos desde a 1ª mensagem da rajada (12:00), não desde a última.
      expect(stats.byAuthor.get(3)).toBe(8)
    })

    it('ordena por tempo mesmo se as linhas chegarem fora de ordem', () => {
      const rows = [
        { conversa_id: 20, direcao: 'out', criado_em: '2026-08-12T15:06:00Z', autor_usuario_id: 4, texto: 'Pronto' },
        { conversa_id: 20, direcao: 'in', criado_em: '2026-08-12T15:00:00Z' },
      ]
      const stats = aggregateResponseStats(rows, triage)
      expect(stats.byAuthor.get(4)).toBe(6)
    })

    it('sem resposta humana → sem par (média nula)', () => {
      const rows = [{ conversa_id: 30, direcao: 'in', criado_em: '2026-08-12T16:00:00Z' }]
      const stats = aggregateResponseStats(rows, triage)
      expect(stats.globalAverage).toBeNull()
      expect(stats.byAuthor.size).toBe(0)
    })
  })
})
