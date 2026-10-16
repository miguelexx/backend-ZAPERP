/**
 * Varredura periódica da mídia recebida SEM URL.
 *
 * O agendamento do backfill ao vivo vive só na MEMÓRIA do processo (debounce 8–60s). Um restart
 * nessa janela matava o reparo e nenhuma outra varredura cobria a linha: as do
 * inboundMediaPersistenceService exigem `midia_persist_status = PENDENTE` ou `url LIKE 'https%'`.
 * A linha ficava quebrada para sempre. Estes testes travam a seleção da varredura que fecha esse
 * buraco — em especial a contenção de cota do provedor, que é o risco real dela.
 */

const { _test, precisaBackfillMidia } = require('../services/inboundMediaBackfillService')
const { selecionarConversasParaVarredura } = _test

const AGORA = Date.parse('2026-10-16T12:00:00.000Z')
const linha = (over = {}) => ({
  id: 1,
  company_id: 1,
  conversa_id: 10,
  tipo: 'audio',
  texto: '(áudio)',
  url: null,
  criado_em: '2026-10-16T11:00:00.000Z',
  ...over,
})

describe('seleção de conversas para a varredura', () => {
  test('agrupa várias linhas quebradas da mesma conversa numa única chamada ao provedor', () => {
    const alvos = selecionarConversasParaVarredura(
      [linha({ id: 1 }), linha({ id: 2 }), linha({ id: 3 })],
      { agora: AGORA }
    )
    expect(alvos).toHaveLength(1)
    expect(alvos[0]).toMatchObject({ company_id: 1, conversa_id: 10, linhas: 3 })
  })

  test('não mistura empresas: mesma conversa_id em empresas diferentes são alvos distintos', () => {
    const alvos = selecionarConversasParaVarredura(
      [linha({ company_id: 1 }), linha({ company_id: 2 })],
      { agora: AGORA }
    )
    expect(alvos).toHaveLength(2)
    expect(alvos.map((a) => a.company_id).sort()).toEqual([1, 2])
  })

  test('linha que não precisa de backfill é ignorada (url utilizável)', () => {
    const alvos = selecionarConversasParaVarredura(
      [linha({ url: '/uploads/a.ogg' }), linha({ conversa_id: 11, url: 'https://cdn/a.ogg' })],
      { agora: AGORA }
    )
    expect(alvos).toEqual([])
  })

  test('texto real sem tipo de mídia não entra (não é mídia quebrada)', () => {
    const alvos = selecionarConversasParaVarredura(
      [linha({ tipo: 'texto', texto: 'bom dia' })],
      { agora: AGORA }
    )
    expect(alvos).toEqual([])
  })

  test('placeholder tipado entra mesmo com tipo texto (foto sem link)', () => {
    const alvos = selecionarConversasParaVarredura(
      [linha({ tipo: 'texto', texto: '(imagem)' })],
      { agora: AGORA }
    )
    expect(alvos).toHaveLength(1)
  })

  test('cooldown impede martelar a mesma conversa a cada rodada', () => {
    const cooldown = new Map([['1:10', AGORA + 3600_000]])
    expect(selecionarConversasParaVarredura([linha()], { agora: AGORA, cooldown })).toEqual([])
    // Depois de vencer, volta a ser candidata.
    expect(
      selecionarConversasParaVarredura([linha()], { agora: AGORA + 2 * 3600_000, cooldown })
    ).toHaveLength(1)
  })

  test('teto por rodada é respeitado — cota do provedor é o risco real da varredura', () => {
    const rows = []
    for (let i = 0; i < 50; i++) rows.push(linha({ id: i, conversa_id: 100 + i }))
    const alvos = selecionarConversasParaVarredura(rows, { agora: AGORA, maxConversas: 5 })
    expect(alvos).toHaveLength(5)
  })

  test('prioriza a mídia mais recente — é a que o atendimento ainda precisa', () => {
    const alvos = selecionarConversasParaVarredura(
      [
        linha({ conversa_id: 1, criado_em: '2026-09-20T10:00:00.000Z' }),
        linha({ conversa_id: 2, criado_em: '2026-10-16T10:00:00.000Z' }),
        linha({ conversa_id: 3, criado_em: '2026-10-01T10:00:00.000Z' }),
      ],
      { agora: AGORA, maxConversas: 2 }
    )
    expect(alvos.map((a) => a.conversa_id)).toEqual([2, 3])
  })

  test('linha sem conversa/empresa válida não vira alvo', () => {
    const alvos = selecionarConversasParaVarredura(
      [linha({ conversa_id: null }), linha({ company_id: 0 }), linha({ conversa_id: 'x' })],
      { agora: AGORA }
    )
    expect(alvos).toEqual([])
  })

  test('entrada vazia ou inválida não quebra', () => {
    expect(selecionarConversasParaVarredura(null, { agora: AGORA })).toEqual([])
    expect(selecionarConversasParaVarredura([], { agora: AGORA })).toEqual([])
    expect(selecionarConversasParaVarredura([null, undefined], { agora: AGORA })).toEqual([])
  })
})

describe('coerência com o backfill ao vivo', () => {
  test('a varredura usa o MESMO critério do backfill (precisaBackfillMidia)', () => {
    const quebrada = linha()
    const sadia = linha({ url: 'https://cdn/a.ogg' })
    expect(precisaBackfillMidia(quebrada)).toBe(true)
    expect(precisaBackfillMidia(sadia)).toBe(false)
    expect(selecionarConversasParaVarredura([quebrada], { agora: AGORA })).toHaveLength(1)
    expect(selecionarConversasParaVarredura([sadia], { agora: AGORA })).toEqual([])
  })
})

describe('recorte no SQL — a varredura não pode depender do filtro em JS', () => {
  const servico = require('../services/inboundMediaBackfillService')

  /**
   * supabase falso que registra os filtros de cada consulta. Devolve linhas com company_id
   * inválido de propósito: a seleção as descarta, então nenhuma chamada ao provedor acontece e
   * o teste mede só a FORMA das consultas.
   */
  function supabaseEspiao() {
    const consultas = []
    const from = () => {
      const filtros = []
      const q = {}
      for (const m of ['select', 'is', 'not', 'gte', 'order', 'limit', 'in']) {
        q[m] = (...args) => { filtros.push({ metodo: m, args }); return q }
      }
      q.then = (resolve) => {
        consultas.push(filtros)
        return resolve({ data: [{ id: 1, company_id: 0, conversa_id: 0 }], error: null })
      }
      return q
    }
    return { consultas, supabase: { from } }
  }

  test('filtra por tipo de mídia E por texto de placeholder no banco, não no JS', async () => {
    const { consultas, supabase } = supabaseEspiao()
    await servico.runInboundMediaNoUrlSweep(supabase, null)

    // Duas consultas: uma pelo tipo real (áudio), outra pelo placeholder (foto/vídeo sem link).
    expect(consultas).toHaveLength(2)
    const colunasIn = consultas
      .map((f) => f.find((x) => x.metodo === 'in')?.args?.[0])
      .sort()
    expect(colunasIn).toEqual(['texto', 'tipo'])
  })

  test('toda consulta carrega url nula, whatsapp_id presente e a janela do provedor', async () => {
    const { consultas, supabase } = supabaseEspiao()
    await servico.runInboundMediaNoUrlSweep(supabase, null)

    for (const filtros of consultas) {
      const is = filtros.find((f) => f.metodo === 'is')
      expect(is.args).toEqual(['url', null])

      const not = filtros.find((f) => f.metodo === 'not')
      expect(not.args).toEqual(['whatsapp_id', 'is', null])

      const gte = filtros.find((f) => f.metodo === 'gte')
      expect(gte.args[0]).toBe('criado_em')
      // Janela de 45 dias: fora dela o provedor não tem o arquivo.
      const janelaMs = Date.now() - Date.parse(gte.args[1])
      expect(janelaMs).toBeGreaterThan(44 * 24 * 3600_000)
      expect(janelaMs).toBeLessThan(46 * 24 * 3600_000)

      expect(filtros.find((f) => f.metodo === 'limit')).toBeTruthy()
    }
  })

  test('mensagem de texto comum NÃO é candidata — url nula sozinha não significa mídia quebrada', () => {
    // A coluna `url` não tem default: toda mensagem de texto tem url nula. Se a varredura
    // dependesse só disso, traria as mais recentes da plataforma e a mídia quebrada nunca entraria.
    const textoComum = {
      id: 9, company_id: 1, conversa_id: 10, tipo: 'texto', texto: 'bom dia', url: null,
      criado_em: new Date().toISOString(),
    }
    expect(selecionarConversasParaVarredura([textoComum], { agora: Date.now() })).toEqual([])
  })
})
