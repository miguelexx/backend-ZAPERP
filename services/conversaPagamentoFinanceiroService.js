const supabase = require('../config/supabase')
const {
  obterDepartamentoIdsFinanceiro,
  usuarioPertenceSetorFinanceiro,
  conversaNoSetorFinanceiro,
} = require('../helpers/financeiroSetorHelper')

const ACAO_AGUARDAR_PAGAMENTO = 'financeiro_aguardando_pagamento'
const ACAO_RETOMAR_COBRANCA = 'financeiro_retomar_em_atendimento'
const ACAO_VENCIMENTO_ATRASO = 'financeiro_pagamento_em_atraso'

const PRAZOS_VALIDOS = new Set(['hoje', 'amanha', '4h', 'data'])

function endOfLocalDay(date) {
  const d = new Date(date)
  d.setHours(23, 59, 59, 999)
  return d
}

/**
 * @param {string} prazo - hoje | amanha | 4h | data
 * @param {string} [dataIso] - YYYY-MM-DD quando prazo=data
 */
function calcularPagamentoPrazoAte(prazo, dataIso) {
  const key = String(prazo || '').trim().toLowerCase()
  const now = new Date()

  if (key === '4h') {
    return new Date(now.getTime() + 4 * 60 * 60 * 1000)
  }
  if (key === 'hoje') {
    return endOfLocalDay(now)
  }
  if (key === 'amanha') {
    const amanha = new Date(now)
    amanha.setDate(amanha.getDate() + 1)
    return endOfLocalDay(amanha)
  }
  if (key === 'data') {
    const raw = String(dataIso || '').trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null
    const parsed = new Date(`${raw}T12:00:00`)
    if (Number.isNaN(parsed.getTime())) return null
    return endOfLocalDay(parsed)
  }
  return null
}

async function assertFluxoFinanceiroPermitido({ company_id, conversa_id, usuario_id, departamento_ids }) {
  const cid = Number(company_id)
  const convId = Number(conversa_id)
  const uid = Number(usuario_id)

  const ehFinanceiro = await usuarioPertenceSetorFinanceiro(departamento_ids, cid)
  if (!ehFinanceiro) {
    return { ok: false, status: 403, error: 'Fluxo de cobrança disponível apenas para o setor Financeiro' }
  }

  const financeiroIds = await obterDepartamentoIdsFinanceiro(cid)

  const { data: row, error: fetchErr } = await supabase
    .from('conversas')
    .select('id, tipo, telefone, status_atendimento, atendente_id, departamento_id')
    .eq('company_id', cid)
    .eq('id', convId)
    .maybeSingle()

  if (fetchErr) return { ok: false, status: 500, error: fetchErr.message, conversa: null }
  if (!row) return { ok: false, status: 404, error: 'Conversa não encontrada', conversa: null }

  const tipo = String(row.tipo || '').toLowerCase()
  const tel = String(row.telefone || '')
  if (tipo === 'grupo' || tel.includes('@g.us')) {
    return { ok: false, status: 400, error: 'Indisponível para conversas de grupo', conversa: null }
  }

  if (!conversaNoSetorFinanceiro(row, financeiroIds)) {
    return {
      ok: false,
      status: 409,
      error: 'Esta conversa não está no setor Financeiro',
      conversa: null,
    }
  }

  return { ok: true, row, financeiroIds, uid }
}

async function marcarAguardandoPagamento({
  company_id,
  conversa_id,
  usuario_id,
  departamento_ids,
  prazo,
  data,
}) {
  const prazoNorm = String(prazo || '').trim().toLowerCase()
  if (!PRAZOS_VALIDOS.has(prazoNorm)) {
    return { ok: false, status: 400, error: 'Prazo inválido', conversa: null }
  }

  const prazoAte = calcularPagamentoPrazoAte(prazoNorm, data)
  if (!prazoAte || Number.isNaN(prazoAte.getTime())) {
    return { ok: false, status: 400, error: 'Data do prazo inválida', conversa: null }
  }

  const gate = await assertFluxoFinanceiroPermitido({
    company_id,
    conversa_id,
    usuario_id,
    departamento_ids,
  })
  if (!gate.ok) return { ...gate, conversa: null }

  const { row } = gate
  const cid = Number(company_id)
  const convId = Number(conversa_id)
  const uid = gate.uid

  if (row.status_atendimento === 'pagamento_pendente') {
    const { data: atual } = await supabase
      .from('conversas')
      .select('*')
      .eq('company_id', cid)
      .eq('id', convId)
      .maybeSingle()
    return { ok: true, status: 200, error: null, conversa: atual, idempotent: true }
  }

  if (row.status_atendimento !== 'em_atendimento') {
    return {
      ok: false,
      status: 409,
      error: 'Só é possível aguardar pagamento a partir de em atendimento',
      conversa: null,
    }
  }
  if (row.atendente_id == null) {
    return { ok: false, status: 409, error: 'Conversa sem atendente atribuído', conversa: null }
  }

  const { data: updated, error: updErr } = await supabase
    .from('conversas')
    .update({
      status_atendimento: 'pagamento_pendente',
      pagamento_prazo_ate: prazoAte.toISOString(),
      pagamento_prazo_origem: prazoNorm,
      aguardando_cliente_desde: null,
      ausencia_mensagem_enviada_em: null,
    })
    .eq('company_id', cid)
    .eq('id', convId)
    .eq('status_atendimento', 'em_atendimento')
    .select()
    .maybeSingle()

  if (updErr) return { ok: false, status: 500, error: updErr.message, conversa: null }
  if (!updated) {
    return {
      ok: false,
      status: 409,
      error: 'Não foi possível atualizar (estado da conversa pode ter mudado)',
      conversa: null,
    }
  }

  await supabase.from('historico_atendimentos').insert({
    conversa_id: convId,
    usuario_id: Number.isFinite(uid) && uid > 0 ? uid : null,
    acao: ACAO_AGUARDAR_PAGAMENTO,
    observacao: `Aguardando pagamento — prazo ${prazoNorm} até ${prazoAte.toISOString()}`,
  })

  return { ok: true, status: 200, error: null, conversa: updated, idempotent: false }
}

async function retomarDeCobrancaFinanceira({ company_id, conversa_id, usuario_id, departamento_ids }) {
  const gate = await assertFluxoFinanceiroPermitido({
    company_id,
    conversa_id,
    usuario_id,
    departamento_ids,
  })
  if (!gate.ok) return { ...gate, conversa: null }

  const { row } = gate
  const cid = Number(company_id)
  const convId = Number(conversa_id)
  const uid = gate.uid

  if (row.status_atendimento === 'em_atendimento') {
    const { data: atual } = await supabase
      .from('conversas')
      .select('*')
      .eq('company_id', cid)
      .eq('id', convId)
      .maybeSingle()
    return { ok: true, status: 200, error: null, conversa: atual, idempotent: true }
  }

  if (row.status_atendimento !== 'pagamento_pendente' && row.status_atendimento !== 'em_atraso') {
    return {
      ok: false,
      status: 409,
      error: 'A conversa não está em cobrança financeira (pagamento pendente ou em atraso)',
      conversa: null,
    }
  }

  const stAntes = row.status_atendimento

  const { data: updated, error: updErr } = await supabase
    .from('conversas')
    .update({
      status_atendimento: 'em_atendimento',
      pagamento_prazo_ate: null,
      pagamento_prazo_origem: null,
      aguardando_cliente_desde: null,
    })
    .eq('company_id', cid)
    .eq('id', convId)
    .in('status_atendimento', ['pagamento_pendente', 'em_atraso'])
    .select()
    .maybeSingle()

  if (updErr) return { ok: false, status: 500, error: updErr.message, conversa: null }
  if (!updated) {
    return {
      ok: false,
      status: 409,
      error: 'Não foi possível atualizar (estado da conversa pode ter mudado)',
      conversa: null,
    }
  }

  await supabase.from('historico_atendimentos').insert({
    conversa_id: convId,
    usuario_id: Number.isFinite(uid) && uid > 0 ? uid : null,
    acao: ACAO_RETOMAR_COBRANCA,
    observacao: `Cobrança encerrada manualmente (estava em ${stAntes}) — retorno para em atendimento`,
  })

  return { ok: true, status: 200, error: null, conversa: updated, idempotent: false }
}

/**
 * Job: pagamento_pendente com prazo vencido → em_atraso.
 */
async function processarVencimentosPagamentoFinanceiro(opts = {}) {
  const dryRun = opts.dryRun === true
  const limit = Math.min(Math.max(Number(opts.limit) || 200, 1), 500)
  const nowIso = new Date().toISOString()

  const { data: rows, error } = await supabase
    .from('conversas')
    .select('id, company_id, status_atendimento, pagamento_prazo_ate, atendente_id')
    .eq('status_atendimento', 'pagamento_pendente')
    .not('pagamento_prazo_ate', 'is', null)
    .lte('pagamento_prazo_ate', nowIso)
    .limit(limit)

  if (error) return { ok: false, error: error.message, processadas: 0, ids: [] }

  const candidatas = Array.isArray(rows) ? rows : []
  if (candidatas.length === 0) {
    return { ok: true, processadas: 0, ids: [], dryRun }
  }

  const ids = candidatas.map((r) => r.id)
  if (dryRun) {
    return { ok: true, processadas: ids.length, ids, dryRun: true }
  }

  let processadas = 0
  for (const conv of candidatas) {
    const { data: updated, error: updErr } = await supabase
      .from('conversas')
      .update({ status_atendimento: 'em_atraso' })
      .eq('id', conv.id)
      .eq('company_id', conv.company_id)
      .eq('status_atendimento', 'pagamento_pendente')
      .select('id')
      .maybeSingle()

    if (updErr || !updated?.id) continue

    processadas++
    await supabase.from('historico_atendimentos').insert({
      conversa_id: conv.id,
      usuario_id: null,
      acao: ACAO_VENCIMENTO_ATRASO,
      observacao: `Prazo de pagamento vencido em ${conv.pagamento_prazo_ate}`,
    })
  }

  return { ok: true, processadas, ids, dryRun: false }
}

module.exports = {
  calcularPagamentoPrazoAte,
  marcarAguardandoPagamento,
  retomarDeCobrancaFinanceira,
  processarVencimentosPagamentoFinanceiro,
  ACAO_AGUARDAR_PAGAMENTO,
  ACAO_RETOMAR_COBRANCA,
  ACAO_VENCIMENTO_ATRASO,
}
