'use strict'

const { clampDays, chunkArray, normalizeOpenAiUsage, addUsage, AI_MODEL } = require('../services/aiDashboard/constants')
const { compactDataForPrompt, stringifyDataForPrompt } = require('../services/aiDashboard/promptPayload')
const { IntentSchema } = require('../services/aiDashboard/intentSchema')
const { LEXICO_FINANCEIRO, LEXICO_COMERCIAL_COMPRA } = require('../services/aiDashboard/lexicos')
const {
  normalizeSearchTerm,
  sanitizeIlikeTerm,
  filtrarConversasIndividuais,
  expandTermosForSearch,
  textoCasaTermoRobusto,
  evidenciasPassamFiltroRobusto,
  extrairTermosBuscaLivre,
} = require('../services/aiDashboard/searchText')
const {
  RECORTE_TZ,
  calendarKeyInTz,
  dayBoundsSpForIsoDate,
  dayBoundsUtc,
  resolveTemporalAnalyticsScope,
  filtrarPorCriadoEm,
  enrichDataReferenciaFromQuestion,
  questionHasExplicitDateRange,
  calendarKeyNowSp,
} = require('../services/aiDashboard/time')
const {
  buildMsgsByConv,
  calcFirstResponseDiff,
  fetchMensagensPaged,
  notaCordialidadePorMensagem,
  classificarMensagemParaResumo,
  dedupeMensagensConsecutivasSemelhantes,
} = require('../services/aiDashboard/firstResponse')
const {
  aplicarHeuristicasDeterministicas,
  isRelatorioProdutividadeQuestion,
  isBuscaConversasQuestion,
  enrichTermosBuscaFromIntent,
} = require('../services/aiDashboard/heuristics')
const {
  sanearRespostaContradicaoMetricas,
  sanearNegacaoComEvidenciaMensagens,
  sanearLinguagemTemporalIndevida,
  sanearRespostaContagensInconsistentes,
} = require('../services/aiDashboard/sanitizers')
const { resolveUsuarioCandidates, resolveClienteCandidates } = require('../services/aiDashboard/resolveEntities')

describe('aiDashboard Sessão A — funções puras', () => {
  describe('constants', () => {
    it('clampDays limita 1–365 e default 7', () => {
      expect(clampDays(undefined)).toBe(7)
      expect(clampDays(0)).toBe(7)
      expect(clampDays(-3)).toBe(7)
      expect(clampDays(1)).toBe(1)
      expect(clampDays(1.9)).toBe(1)
      expect(clampDays(365)).toBe(365)
      expect(clampDays(400)).toBe(365)
    })

    it('chunkArray fatia sem mutar vazio', () => {
      expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
      expect(chunkArray(null, 2)).toEqual([])
    })

    it('normalizeOpenAiUsage e addUsage somam tokens', () => {
      const a = normalizeOpenAiUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
      const b = normalizeOpenAiUsage({ input_tokens: 2, output_tokens: 3 })
      expect(addUsage(a, b)).toEqual({ prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 })
      expect(normalizeOpenAiUsage(null)).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 })
    })

    it('AI_MODEL default gpt-4o-mini', () => {
      const prev = process.env.AI_MODEL
      delete process.env.AI_MODEL
      expect(AI_MODEL()).toBe('gpt-4o-mini')
      if (prev != null) process.env.AI_MODEL = prev
    })
  })

  describe('promptPayload', () => {
    it('compactDataForPrompt trunca string longa', () => {
      const s = 'x'.repeat(1300)
      const out = compactDataForPrompt(s)
      expect(out).toContain('[truncado]')
      expect(out.length).toBeLessThan(s.length)
    })

    it('stringifyDataForPrompt devolve JSON do compact', () => {
      const json = stringifyDataForPrompt({ a: 1 })
      expect(JSON.parse(json)).toEqual({ a: 1 })
    })
  })

  describe('IntentSchema', () => {
    it('aceita allowlist e rejeita intent inventado', () => {
      expect(IntentSchema.safeParse({ intent: 'METRICS_OVERVIEW' }).success).toBe(true)
      expect(IntentSchema.safeParse({ intent: 'UNKNOWN' }).success).toBe(true)
      expect(IntentSchema.safeParse({ intent: 'SQL_LIVRE' }).success).toBe(false)
    })

    it('preprocessa termos_busca de string', () => {
      const r = IntentSchema.safeParse({ intent: 'BUSCA_CONTEUDO_MENSAGENS', termos_busca: 'boleto, pix' })
      expect(r.success).toBe(true)
      expect(r.data.termos_busca).toEqual(['boleto', 'pix'])
    })
  })

  describe('searchText', () => {
    it('normalizeSearchTerm remove acento', () => {
      expect(normalizeSearchTerm('Promoção')).toBe('promocao')
    })

    it('sanitizeIlikeTerm remove curingas PostgREST', () => {
      expect(sanitizeIlikeTerm('a%b_c')).toBe('a b c')
    })

    it('filtrarConversasIndividuais exclui grupo e @g.us', () => {
      const rows = [
        { id: 1, tipo: null, telefone: '5511999' },
        { id: 2, tipo: 'grupo', telefone: 'x' },
        { id: 3, tipo: 'group', telefone: 'y' },
        { id: 4, tipo: 'individual', telefone: '5511@g.us' },
      ]
      expect(filtrarConversasIndividuais(rows).map((r) => r.id)).toEqual([1])
    })

    it('textoCasaTermoRobusto exige palavra para nf/pix', () => {
      expect(textoCasaTermoRobusto('emitir nf amanha', 'nf')).toBe(true)
      expect(textoCasaTermoRobusto('info extra', 'nf')).toBe(false)
      expect(textoCasaTermoRobusto('pague via pix agora', 'pix')).toBe(true)
    })

    it('expandTermosForSearch gera variantes e respeita max', () => {
      const out = expandTermosForSearch(['promoção'], 8)
      expect(out.length).toBeGreaterThan(0)
      expect(out.length).toBeLessThanOrEqual(8)
      expect(out.some((t) => normalizeSearchTerm(t).includes('promoc'))).toBe(true)
    })

    it('evidenciasPassamFiltroRobusto filtra preview', () => {
      const ev = [
        { texto_preview: 'segunda via do boleto' },
        { texto_preview: 'oi' },
      ]
      expect(evidenciasPassamFiltroRobusto(ev, ['boleto'])).toHaveLength(1)
    })

    it('extrairTermosBuscaLivre pega tema após "falam sobre"', () => {
      const terms = extrairTermosBuscaLivre('quais conversas falam sobre boleto')
      expect(terms.some((t) => normalizeSearchTerm(t).includes('boleto'))).toBe(true)
    })
  })

  describe('time America/Sao_Paulo', () => {
    const KEY = '2026-08-31'

    it('RECORTE_TZ é SP e não UTC cru', () => {
      expect(RECORTE_TZ).toBe('America/Sao_Paulo')
    })

    it('dayBoundsSpForIsoDate cobre o dia civil SP', () => {
      const b = dayBoundsSpForIsoDate(KEY)
      expect(b.inicio).toBeTruthy()
      expect(b.fim).toBeTruthy()
      expect(calendarKeyInTz(b.inicio)).toBe(KEY)
      expect(calendarKeyInTz(new Date(Date.parse(b.fim) - 1).toISOString())).toBe(KEY)
    })

    it('dayBoundsUtc é meia-noite UTC (não unificar com SP)', () => {
      const u = dayBoundsUtc(KEY)
      expect(u.inicio).toBe('2026-08-31T00:00:00.000Z')
      expect(u.fim).toBe('2026-09-01T00:00:00.000Z')
      const sp = dayBoundsSpForIsoDate(KEY)
      expect(sp.inicio).not.toBe(u.inicio)
    })

    it('resolveTemporalAnalyticsScope interpreta hoje/ontem no fuso SP', () => {
      jest.useFakeTimers()
      jest.setSystemTime(new Date('2026-08-31T15:00:00.000Z'))
      try {
        expect(calendarKeyNowSp()).toBe('2026-08-31')
        const hoje = resolveTemporalAnalyticsScope('atendimentos de hoje', { intent: 'HISTORICO_ATENDENTE' })
        expect(hoje.fixado_na_pergunta).toBe(true)
        expect(hoje.opts.periodo_fixado_na_pergunta).toBe(true)
        expect(calendarKeyInTz(hoje.opts.periodo_mensagens_inicio_iso)).toBe('2026-08-31')

        const ontem = resolveTemporalAnalyticsScope('o que aconteceu ontem', { intent: 'BUSCA_CONTEUDO_MENSAGENS' })
        expect(calendarKeyInTz(ontem.opts.periodo_mensagens_inicio_iso)).toBe('2026-08-30')
      } finally {
        jest.useRealTimers()
      }
    })

    it('range explícito e data_referencia_iso', () => {
      const range = resolveTemporalAnalyticsScope('entre 01/08 e 03/08', { intent: 'BUSCA_CONTEUDO_MENSAGENS' })
      expect(range.fixado_na_pergunta).toBe(true)
      expect(questionHasExplicitDateRange('entre 01/08 e 03/08')).toBe(true)

      const cls = enrichDataReferenciaFromQuestion(
        { intent: 'BUSCA_CONTEUDO_MENSAGENS' },
        'mensagens do dia 14/04'
      )
      expect(cls.data_referencia_iso).toMatch(/^\d{4}-04-14$/)
    })

    it('filtrarPorCriadoEm usa intervalo [inicio, fim)', () => {
      const list = [
        { criado_em: '2026-08-31T10:00:00.000Z' },
        { criado_em: '2026-09-01T10:00:00.000Z' },
      ]
      const out = filtrarPorCriadoEm(list, '2026-08-31T00:00:00.000Z', '2026-09-01T00:00:00.000Z')
      expect(out).toHaveLength(1)
    })
  })

  describe('firstResponse', () => {
    it('calcFirstResponseDiff usa primeiro in e out posterior', () => {
      const t0 = Date.parse('2026-08-31T12:00:00.000Z')
      const map = buildMsgsByConv([
        { conversa_id: 1, criado_em: new Date(t0).toISOString(), direcao: 'in' },
        { conversa_id: 1, criado_em: new Date(t0 + 5 * 60000).toISOString(), direcao: 'out' },
      ])
      expect(calcFirstResponseDiff(map.get(1))).toBe(5)
    })

    it('fetchMensagensPaged pagina até batch curto', async () => {
      const pages = [[1, 2], [3]]
      let i = 0
      const rows = await fetchMensagensPaged(async () => {
        const data = pages[i++] || []
        return { data, error: null }
      }, { pageSize: 2, maxRows: 10 })
      expect(rows).toEqual([1, 2, 3])
    })

    it('cordialidade e dedupe', () => {
      expect(notaCordialidadePorMensagem('bom dia, por favor').positivos).toBeGreaterThan(0)
      const flags = classificarMensagemParaResumo({ texto: 'oi', tipo: 'texto' })
      expect(flags.sinal_baixo_valor_informativo).toBe(true)
      expect(dedupeMensagensConsecutivasSemelhantes([
        { direcao: 'out', texto: 'ok' },
        { direcao: 'out', texto: 'ok' },
        { direcao: 'in', texto: 'ok' },
      ])).toHaveLength(2)
    })
  })

  describe('heuristics (duas passagens)', () => {
    it('força relatório de produtividade', () => {
      expect(isRelatorioProdutividadeQuestion('exportar planilha de produtividade dos atendentes')).toBe(true)
      const once = aplicarHeuristicasDeterministicas({ intent: 'UNKNOWN' }, 'exportar csv de desempenho da equipe')
      expect(once.intent).toBe('RELATORIO_PRODUTIVIDADE_ATENDENTES')
      const twice = aplicarHeuristicasDeterministicas(once, 'exportar csv de desempenho da equipe')
      expect(twice.intent).toBe('RELATORIO_PRODUTIVIDADE_ATENDENTES')
    })

    it('força busca de conteúdo quando a pergunta pede conversas sobre tema', () => {
      const q = 'quais conversas falam sobre boleto'
      expect(isBuscaConversasQuestion(q)).toBe(true)
      let cls = aplicarHeuristicasDeterministicas({ intent: 'UNKNOWN' }, q)
      cls = enrichTermosBuscaFromIntent(cls, q)
      cls = aplicarHeuristicasDeterministicas(cls, q)
      expect(cls.intent).toBe('BUSCA_CONTEUDO_MENSAGENS')
      expect(cls.termos_busca?.length).toBeGreaterThan(0)
    })

    it('preenche léxico financeiro se termos vazios', () => {
      const cls = enrichTermosBuscaFromIntent({ intent: 'CLIENTES_POR_TEMA_FINANCEIRO', termos_busca: [] }, 'x')
      expect(cls.termos_busca).toEqual(expect.arrayContaining(LEXICO_FINANCEIRO.slice(0, 1)))
    })

    it('preenche léxico comercial em sinais de compra', () => {
      const cls = enrichTermosBuscaFromIntent({ intent: 'SINAIS_INTERESSE_COMPRA' }, 'x')
      expect(cls.termos_busca.some((t) => LEXICO_COMERCIAL_COMPRA.includes(t))).toBe(true)
    })
  })

  describe('sanitizers', () => {
    it('contradiz negação quando overview tem totais > 0', () => {
      const out = sanearRespostaContradicaoMetricas(
        'Não houve conversas no período.',
        'METRICS_OVERVIEW',
        { totalConversas: 12, mensagensRecebidas: 3, atendimentosHoje: 0 }
      )
      expect(out).toMatch(/Correção automática/)
      expect(out).toMatch(/totalConversas/)
    })

    it('não inventa correção se totais são zero', () => {
      const ans = 'Não houve conversas no período.'
      expect(sanearRespostaContradicaoMetricas(ans, 'METRICS_OVERVIEW', { totalConversas: 0 })).toBe(ans)
    })

    it('negação com evidência de mensagens', () => {
      const out = sanearNegacaoComEvidenciaMensagens(
        'Não encontramos mensagens.',
        'HISTORICO_CLIENTE',
        { mensagens: [{ id: 1 }] }
      )
      expect(out).toMatch(/Correção automática/)
    })

    it('linguagem temporal indevida quando recorte impede "hoje"', () => {
      const out = sanearLinguagemTemporalIndevida(
        'O cliente falou isso hoje.',
        'BUSCA_CONTEUDO_MENSAGENS',
        {
          recorte_temporal: {
            pode_usar_hoje_no_texto: false,
            primeiro_data_exibicao: '01/08/2026',
            ultimo_data_exibicao: '03/08/2026',
            fuso: 'America/Sao_Paulo',
          },
        }
      )
      expect(out).toMatch(/Correção temporal/)
    })

    it('contagens inconsistentes vs resumo_operacional_ia', () => {
      const out = sanearRespostaContagensInconsistentes(
        'Foi um cliente no recorte.',
        'HISTORICO_CLIENTE',
        { resumo_operacional_ia: { total_clientes_unicos: 4, total_conversas: 4, total_mensagens: 10 } }
      )
      expect(out).toMatch(/Verificação/)
    })
  })

  describe('resolveEntities (sem I/O quando entrada vazia)', () => {
    it('usuario sem nome não consulta', async () => {
      await expect(resolveUsuarioCandidates(1, '')).resolves.toEqual({
        id: null,
        candidatos: [],
        ambiguous: false,
      })
    })

    it('cliente sem nome/telefone não consulta', async () => {
      await expect(resolveClienteCandidates(1, '', '')).resolves.toEqual({
        id: null,
        candidatos: [],
        ambiguous: false,
      })
    })
  })
})
