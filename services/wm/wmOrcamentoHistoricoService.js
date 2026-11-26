'use strict'

/**
 * Página de Integrações → aba "Orçamentos" (ERP Icthus via API WM).
 *
 * SÓ LEITURA. Nada aqui fala com a WM: tudo vem de `wm_orcamento_operacoes`, que já é o registro
 * local de cada preparação/criação. Por isso a tela de histórico funciona mesmo com o
 * sincronizador da loja desligado.
 *
 * ISOLAMENTO:
 *   · toda query filtra `company_id` (SERVICE_ROLE bypassa RLS);
 *   · quem NÃO tem `orcamentos.ver_historico_empresa` só enxerga as próprias operações
 *     (`usuario_id` do token) — o filtro é imposto aqui, não confiado ao navegador;
 *   · as colunas sensíveis (`comando_id`, `payload_criacao`, `payload_hash`) nunca são lidas.
 */

const supabase = require('../../config/supabase')
const configService = require('./wmIntegrationConfigService')

const TABELA = 'wm_orcamento_operacoes'

/** Colunas lidas para a listagem. Sem comando_id / payload_* por desenho. */
const COLUNAS_LISTA = [
  'id',
  'usuario_id',
  'conversa_id',
  'estado',
  'previa_sanitizada',
  'wm_resultado_sanitizado',
  'erro_codigo_ultimo',
  'tentativas',
  'criado_em',
  'enviado_em',
  'concluido_em',
].join(', ')

/** Grupos de estado expostos ao filtro da tela (vocabulário fechado). */
const GRUPOS_ESTADO = Object.freeze({
  registrados: ['CRIADO', 'ENVIANDO', 'INCERTO', 'FALHA_SEGURA'],
  criados: ['CRIADO'],
  atencao: ['INCERTO', 'FALHA_SEGURA'],
  andamento: ['ENVIANDO'],
  rascunhos: ['PREPARADO', 'EXPIRADO'],
  todos: null,
})

const PERIODOS_DIAS = Object.freeze({ '7': 7, '30': 30, '90': 90, '365': 365, todos: null })
const POR_PAGINA_PADRAO = 20
const POR_PAGINA_MAX = 50
/** Teto da amostra que alimenta os indicadores — evita varrer anos de histórico por F5. */
const RESUMO_AMOSTRA_MAX = 5000

function inteiroPositivo(v) {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

/** Decimal invariant da WM ("33.038") → number para somar. Fora do padrão → 0. */
function paraNumero(valor) {
  if (typeof valor !== 'string' && typeof valor !== 'number') return 0
  const s = String(valor).trim()
  if (!/^-?\d+(?:\.\d+)?$/.test(s)) return 0
  const n = Number(s)
  return Number.isFinite(n) ? n : 0
}

/**
 * Termo de busca seguro para o `.or()` do PostgREST: tira os caracteres que mudam a gramática
 * do filtro (vírgula, parênteses, curingas, aspas, barra invertida). Sem eles não há injeção de
 * filtro — e nome de cliente/número de orçamento não precisa de nenhum deles.
 */
function termoBuscaSeguro(bruto) {
  if (typeof bruto !== 'string') return ''
  return bruto
    .replace(/[,()*%"'\\:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
}

/** Lê e normaliza os filtros da query string. Nunca lança: valor estranho cai no padrão. */
function normalizarFiltros(q = {}) {
  const estado = Object.prototype.hasOwnProperty.call(GRUPOS_ESTADO, q.estado) ? q.estado : 'registrados'
  const periodo = Object.prototype.hasOwnProperty.call(PERIODOS_DIAS, String(q.periodo))
    ? String(q.periodo)
    : '30'
  const pagina = inteiroPositivo(q.pagina) || 1
  const porPagina = Math.min(inteiroPositivo(q.por_pagina) || POR_PAGINA_PADRAO, POR_PAGINA_MAX)
  const busca = termoBuscaSeguro(q.busca)
  const apenasMeus = q.apenas_meus === '1' || q.apenas_meus === 'true' || q.apenas_meus === true
  return { estado, periodo, pagina, porPagina, busca, apenasMeus }
}

function desdeIso(periodo, agora = Date.now()) {
  const dias = PERIODOS_DIAS[periodo]
  if (!dias) return null
  return new Date(agora - dias * 24 * 60 * 60 * 1000).toISOString()
}

/** Valor do orçamento: o do ERP (criado) quando existe, senão o da prévia. */
function valorDaOperacao(row) {
  const r = row?.wm_resultado_sanitizado
  if (r && r.valor_total != null) return paraNumero(r.valor_total)
  const p = row?.previa_sanitizada
  return p ? paraNumero(p.valor_total) : 0
}

async function carregarNomes({ company_id, usuarioIds, conversaIds }) {
  const usuarios = new Map()
  const contatos = new Map()

  const tarefas = []
  if (usuarioIds.length) {
    tarefas.push(
      supabase
        .from('usuarios')
        .select('id, nome')
        .eq('company_id', company_id)
        .in('id', usuarioIds)
        .then(({ data }) => {
          for (const u of data || []) usuarios.set(Number(u.id), u.nome || null)
        }, () => {})
    )
  }
  if (conversaIds.length) {
    tarefas.push(
      supabase
        .from('conversas')
        .select('id, cliente_id, telefone')
        .eq('company_id', company_id)
        .in('id', conversaIds)
        .then(async ({ data }) => {
          const convs = data || []
          const clienteIds = [...new Set(convs.map((c) => c.cliente_id).filter(Boolean))]
          const clientes = new Map()
          if (clienteIds.length) {
            const { data: cli } = await supabase
              .from('clientes')
              .select('id, nome, pushname, telefone')
              .eq('company_id', company_id)
              .in('id', clienteIds)
            for (const c of cli || []) clientes.set(Number(c.id), c)
          }
          for (const c of convs) {
            const cli = clientes.get(Number(c.cliente_id))
            contatos.set(Number(c.id), {
              nome: cli?.nome || cli?.pushname || null,
              telefone: cli?.telefone || c.telefone || null,
            })
          }
        }, () => {})
    )
  }
  await Promise.all(tarefas)
  return { usuarios, contatos }
}

/** Projeção de uma linha para a tela. Sem nada que não seja exibição. */
function projetarLinha(row, { usuarios, contatos }) {
  const previa = row.previa_sanitizada || null
  const resultado = row.wm_resultado_sanitizado || null
  const itens = Array.isArray(previa?.itens) ? previa.itens : []
  return {
    operacao_id: row.id,
    estado: row.estado,
    numero_erp: resultado?.codigo_pedido_erp || null,
    documento_venda: resultado?.documento_venda || null,
    bloqueado: typeof resultado?.bloqueado === 'boolean' ? resultado.bloqueado : null,
    cliente: resultado?.cliente || previa?.cliente || null,
    vendedor: resultado?.vendedor || previa?.vendedor || null,
    valor_total: resultado?.valor_total ?? previa?.valor_total ?? null,
    valor_produtos: previa?.valor_produtos ?? null,
    itens: itens.map((it) => ({
      codigo_produto_erp: it.codigo_produto_erp ?? null,
      descricao: it.descricao ?? null,
      quantidade: it.quantidade ?? null,
      preco_unitario: it.preco_unitario ?? null,
      valor_total: it.valor_total ?? null,
      valor_desconto_unit: it.valor_desconto_unit ?? null,
      preco_negociado: it.preco_negociado ?? null,
    })),
    qtd_itens: itens.length,
    conversa_id: row.conversa_id ?? null,
    contato: row.conversa_id ? contatos.get(Number(row.conversa_id)) || null : null,
    usuario: row.usuario_id
      ? { id: Number(row.usuario_id), nome: usuarios.get(Number(row.usuario_id)) || null }
      : null,
    erro_codigo: row.erro_codigo_ultimo ?? null,
    tentativas: Number(row.tentativas) || 0,
    criado_em: row.criado_em ?? null,
    enviado_em: row.enviado_em ?? null,
    concluido_em: row.concluido_em ?? null,
  }
}

/**
 * Indicadores do período (mesmo escopo de visibilidade da lista, sem filtro de estado/busca):
 * criados, valor criado, ticket médio, pendências, série diária e ranking de quem mais orçou.
 */
async function calcularResumo({ company_id, usuarioFiltro, desde, periodo }) {
  let q = supabase
    .from(TABELA)
    .select('usuario_id, estado, previa_sanitizada, wm_resultado_sanitizado, criado_em')
    .eq('company_id', company_id)
    .in('estado', GRUPOS_ESTADO.registrados)
    .order('criado_em', { ascending: false })
    .limit(RESUMO_AMOSTRA_MAX)
  if (usuarioFiltro) q = q.eq('usuario_id', usuarioFiltro)
  if (desde) q = q.gte('criado_em', desde)

  const { data, error } = await q
  if (error) return null
  const rows = data || []

  let criados = 0
  let valorCriado = 0
  let atencao = 0
  let andamento = 0
  const porDia = new Map()
  const porUsuario = new Map()

  for (const r of rows) {
    if (r.estado === 'CRIADO') {
      const v = valorDaOperacao(r)
      criados += 1
      valorCriado += v
      const dia = String(r.criado_em || '').slice(0, 10)
      if (dia) {
        const d = porDia.get(dia) || { dia, quantidade: 0, valor: 0 }
        d.quantidade += 1
        d.valor += v
        porDia.set(dia, d)
      }
      if (r.usuario_id) {
        const u = porUsuario.get(Number(r.usuario_id)) || { usuario_id: Number(r.usuario_id), quantidade: 0, valor: 0 }
        u.quantidade += 1
        u.valor += v
        porUsuario.set(Number(r.usuario_id), u)
      }
    } else if (r.estado === 'INCERTO' || r.estado === 'FALHA_SEGURA') {
      atencao += 1
    } else if (r.estado === 'ENVIANDO') {
      andamento += 1
    }
  }

  // Série contínua (dias sem orçamento aparecem como zero) — no máximo 90 pontos.
  const diasSerie = Math.min(PERIODOS_DIAS[periodo] || 30, 90)
  const serie = []
  const hoje = new Date()
  for (let i = diasSerie - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate() - i))
    const chave = d.toISOString().slice(0, 10)
    const ponto = porDia.get(chave)
    serie.push({ dia: chave, quantidade: ponto?.quantidade || 0, valor: Math.round((ponto?.valor || 0) * 100) / 100 })
  }

  const topIds = [...porUsuario.values()].sort((a, b) => b.valor - a.valor || b.quantidade - a.quantidade).slice(0, 5)
  const { usuarios } = await carregarNomes({
    company_id,
    usuarioIds: topIds.map((u) => u.usuario_id),
    conversaIds: [],
  })

  return {
    criados,
    valor_criado: Math.round(valorCriado * 100) / 100,
    ticket_medio: criados ? Math.round((valorCriado / criados) * 100) / 100 : 0,
    atencao,
    andamento,
    taxa_sucesso: criados + atencao > 0 ? Math.round((criados / (criados + atencao)) * 1000) / 10 : null,
    amostra_truncada: rows.length >= RESUMO_AMOSTRA_MAX,
    serie,
    top_usuarios: topIds.map((u) => ({
      usuario_id: u.usuario_id,
      nome: usuarios.get(u.usuario_id) || null,
      quantidade: u.quantidade,
      valor: Math.round(u.valor * 100) / 100,
    })),
  }
}

/**
 * Lista paginada + indicadores.
 *
 * @param {object} args
 * @param {number} args.company_id     sempre de req.user.company_id
 * @param {number} args.usuario_id     sempre de req.user.id
 * @param {boolean} args.verEmpresa    resultado de `orcamentos.ver_historico_empresa`
 * @param {object} args.query          req.query cru
 */
async function listarHistorico({ company_id, usuario_id, verEmpresa, query } = {}) {
  const cid = inteiroPositivo(company_id)
  if (!cid) return { ok: false, httpStatus: 403 }
  const uid = inteiroPositivo(usuario_id)
  const f = normalizarFiltros(query)

  // Sem permissão de empresa: escopo forçado ao próprio usuário, ignorando o pedido.
  const usuarioFiltro = !verEmpresa || f.apenasMeus ? uid : null
  if (!verEmpresa && !uid) return { ok: false, httpStatus: 403 }
  const desde = desdeIso(f.periodo)

  let q = supabase
    .from(TABELA)
    .select(COLUNAS_LISTA, { count: 'exact' })
    .eq('company_id', cid)
    .order('criado_em', { ascending: false })
  const estados = GRUPOS_ESTADO[f.estado]
  if (estados) q = q.in('estado', estados)
  if (usuarioFiltro) q = q.eq('usuario_id', usuarioFiltro)
  if (desde) q = q.gte('criado_em', desde)
  if (f.busca) {
    const t = f.busca
    q = q.or(
      [
        `previa_sanitizada->cliente->>nome.ilike.*${t}*`,
        `wm_resultado_sanitizado->>codigo_pedido_erp.ilike.*${t}*`,
        `previa_sanitizada->vendedor->>nome.ilike.*${t}*`,
      ].join(',')
    )
  }
  const inicio = (f.pagina - 1) * f.porPagina
  q = q.range(inicio, inicio + f.porPagina - 1)

  const [lista, resumo] = await Promise.all([
    q,
    calcularResumo({ company_id: cid, usuarioFiltro, desde, periodo: f.periodo }).catch(() => null),
  ])

  if (lista.error) {
    console.warn('[wmOrcamentoHistorico] leitura indisponível', cid)
    return { ok: false, httpStatus: 503 }
  }

  const rows = lista.data || []
  const nomes = await carregarNomes({
    company_id: cid,
    usuarioIds: [...new Set(rows.map((r) => Number(r.usuario_id)).filter(Boolean))],
    conversaIds: [...new Set(rows.map((r) => Number(r.conversa_id)).filter(Boolean))],
  })

  const total = Number(lista.count) || 0
  return {
    ok: true,
    resultado: {
      filtros: {
        estado: f.estado,
        periodo: f.periodo,
        busca: f.busca,
        apenas_meus: !!usuarioFiltro,
      },
      escopo: verEmpresa ? 'empresa' : 'proprio',
      itens: rows.map((r) => projetarLinha(r, nomes)),
      paginacao: {
        pagina: f.pagina,
        por_pagina: f.porPagina,
        total,
        total_paginas: Math.max(1, Math.ceil(total / f.porPagina)),
      },
      resumo,
    },
  }
}

/**
 * Cartão da integração: vínculo (sem segredo) + quando foi o último orçamento criado.
 */
async function obterResumoIntegracao({ company_id, verEmpresa, podeCriar } = {}) {
  const cid = inteiroPositivo(company_id)
  if (!cid) return { ok: false, httpStatus: 403 }

  const [config, ultimo, totalCriados] = await Promise.all([
    configService.obterConfigPublica(cid),
    supabase
      .from(TABELA)
      .select('concluido_em, criado_em')
      .eq('company_id', cid)
      .eq('estado', 'CRIADO')
      .order('criado_em', { ascending: false })
      .limit(1)
      .maybeSingle()
      .then((r) => r, () => ({ data: null })),
    supabase
      .from(TABELA)
      .select('id', { count: 'exact', head: true })
      .eq('company_id', cid)
      .eq('estado', 'CRIADO')
      .then((r) => r, () => ({ count: null })),
  ])

  return {
    ok: true,
    resultado: {
      integracao: {
        provedor: 'wm',
        erp: 'Icthus',
        ...config,
      },
      ultimo_orcamento_em: ultimo?.data?.concluido_em || ultimo?.data?.criado_em || null,
      total_orcamentos_criados: Number.isFinite(Number(totalCriados?.count)) ? Number(totalCriados.count) : null,
      permissoes: {
        ver_historico_empresa: !!verEmpresa,
        criar: !!podeCriar,
      },
    },
  }
}

module.exports = {
  GRUPOS_ESTADO,
  PERIODOS_DIAS,
  normalizarFiltros,
  termoBuscaSeguro,
  listarHistorico,
  obterResumoIntegracao,
  // expostos para teste
  projetarLinha,
  valorDaOperacao,
}
