'use strict'

const crypto = require('crypto')
const supabase = require('../../config/supabase')

/**
 * Tabela em memória para `wm_orcamento_operacoes`, com UMA propriedade que o mock padrão de
 * `tests/setup.js` não tem e que é o ponto inteiro desta sessão: **UPDATE condicional**.
 *
 * A trava de concorrência do orçamento não é rate limit nem frontend — é o
 * `UPDATE … WHERE estado='PREPARADO' AND expira_em > now()` da seção 7 do doc 36. Um mock que
 * devolve sempre a mesma linha não pode provar "duplo clique chama a WM uma vez": ele passaria
 * mesmo com a trava removida do código. Então este fake modela:
 *
 *   · casamento de filtros (`eq`, `gt`, `is`) linha por linha;
 *   · `update` que só atinge as linhas que casam e devolve `null` quando nenhuma casa
 *     (é assim que o perdedor da disputa descobre que perdeu);
 *   · **seção crítica**: o casamento e a aplicação do patch acontecem juntos, sem `await` no
 *     meio, como no Postgres. Há um ponto de interleaving ANTES dela, para que duas chamadas
 *     concorrentes realmente disputem;
 *   · projeção de colunas do `.select('a, b, c')` — é o que prova que `payload_criacao` não
 *     vaza para quem não o pediu.
 */

const AGORA_COLUNAS_TIMESTAMP = new Set(['expira_em', 'enviado_em', 'concluido_em', 'criado_em', 'atualizado_em', 'validado_em'])

function projetar(row, colunas) {
  if (!row) return null
  if (!colunas) return { ...row }
  const lista = String(colunas)
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
  if (!lista.length || lista.includes('*')) return { ...row }
  const out = {}
  for (const c of lista) out[c] = row[c] === undefined ? null : row[c]
  return out
}

function mesmoValor(a, b) {
  if (a === b) return true
  if (a == null || b == null) return false
  // PostgREST compara textualmente; integer vs '7' não deve dar falso negativo no fake.
  return String(a) === String(b)
}

function maiorQue(valorLinha, valorFiltro, coluna) {
  if (valorLinha == null) return false
  if (AGORA_COLUNAS_TIMESTAMP.has(coluna)) {
    const a = Date.parse(valorLinha)
    const b = Date.parse(valorFiltro)
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false
    return a > b
  }
  return Number(valorLinha) > Number(valorFiltro)
}

/**
 * @param {object} [opts]
 * @param {object[]} [opts.linhas] linhas iniciais de `wm_orcamento_operacoes`
 */
function criarFakeDb({ linhas = [] } = {}) {
  const estado = {
    operacoes: linhas.map((l) => ({ ...l })),
    /** Chamadas registradas: { tabela, modo, filtros, patch, colunas } */
    chamadas: [],
    /** Força erro de banco: { insert?: true, update?: true, select?: true } */
    falhar: {},
  }

  function executar(ctx) {
    const { tabela, modo, filtros, patch, colunas, payload } = ctx

    if (tabela !== 'wm_orcamento_operacoes') {
      // Outras tabelas (auditoria, config) não são objeto deste fake.
      return { data: null, error: null }
    }
    if (estado.falhar[modo]) return { data: null, error: { message: 'falha simulada de banco' } }

    const casa = (row) => filtros.every((f) => {
      if (f.op === 'eq') return mesmoValor(row[f.coluna], f.valor)
      if (f.op === 'gt') return maiorQue(row[f.coluna], f.valor, f.coluna)
      if (f.op === 'is') return f.valor === null ? row[f.coluna] == null : mesmoValor(row[f.coluna], f.valor)
      return true
    })

    if (modo === 'insert') {
      const novo = {
        id: payload.id || crypto.randomUUID(),
        estado: 'PREPARADO',
        comando_id: null,
        payload_criacao: null,
        payload_hash: null,
        previa_sanitizada: null,
        wm_resultado_sanitizado: null,
        http_status_ultimo: null,
        erro_codigo_ultimo: null,
        tentativas: 0,
        expira_em: null,
        enviado_em: null,
        concluido_em: null,
        concluido: null,
        ...payload,
      }
      estado.operacoes.push(novo)
      return { data: projetar(novo, colunas), error: null }
    }

    if (modo === 'update') {
      const atingidas = estado.operacoes.filter(casa)
      for (const row of atingidas) Object.assign(row, patch)
      return { data: atingidas.length ? projetar(atingidas[0], colunas) : null, error: null }
    }

    const encontradas = estado.operacoes.filter(casa)
    return { data: encontradas.length ? projetar(encontradas[0], colunas) : null, error: null }
  }

  function builder(tabela) {
    const ctx = { tabela, modo: 'select', filtros: [], patch: null, colunas: null, payload: null }
    const chain = {
      select: (colunas) => { ctx.colunas = colunas || null; return chain },
      insert: (payload) => { ctx.modo = 'insert'; ctx.payload = payload; return chain },
      update: (patch) => { ctx.modo = 'update'; ctx.patch = patch; return chain },
      eq: (coluna, valor) => { ctx.filtros.push({ op: 'eq', coluna, valor }); return chain },
      gt: (coluna, valor) => { ctx.filtros.push({ op: 'gt', coluna, valor }); return chain },
      is: (coluna, valor) => { ctx.filtros.push({ op: 'is', coluna, valor }); return chain },
      order: () => chain,
      limit: () => chain,
      async maybeSingle() { return finalizar() },
      async single() { return finalizar() },
      // A query sem terminal explícito também é aguardável (o `update` de invalidação é assim).
      then(resolve, reject) { return finalizar().then(resolve, reject) },
    }

    async function finalizar() {
      // Ponto de interleaving: duas chamadas concorrentes chegam aqui antes de qualquer uma
      // aplicar o patch. O que vem depois é síncrono — a seção crítica.
      await Promise.resolve()
      const r = executar(ctx)
      estado.chamadas.push({
        tabela: ctx.tabela,
        modo: ctx.modo,
        filtros: ctx.filtros.map((f) => [f.op, f.coluna, f.valor]),
        patch: ctx.patch ? { ...ctx.patch } : null,
        colunas: ctx.colunas,
      })
      return r
    }

    return chain
  }

  supabase.from.mockImplementation(builder)
  return estado
}

module.exports = { criarFakeDb }
