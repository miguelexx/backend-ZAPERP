/**
 * Opt-out: processa comandos PARAR, SAIR, DESCADASTRAR no webhook.
 * Chamado antes do chatbot — não altera fluxo existente.
 */

/** Comandos que acionam opt-out (case-insensitive, normalizado) */
const COMANDOS_OPT_OUT = ['PARAR', 'SAIR', 'DESCADASTRAR', 'CANCELAR', 'REMOVER', 'UNSUBSCRIBE', 'STOP', 'OPT OUT']

function normalizeText(t) {
  if (!t || typeof t !== 'string') return ''
  return t.trim().toUpperCase().normalize('NFD').replace(/\p{Diacritic}/gu, '')
}

function isOptOutCommand(texto) {
  const n = normalizeText(texto)
  if (!n) return false
  return COMANDOS_OPT_OUT.some((cmd) => n === cmd || n.startsWith(cmd + ' ') || n.endsWith(' ' + cmd))
}

/**
 * Processa opt-out: se texto for comando, registra e retorna mensagem de confirmação.
 * @param {object} opts
 * @param {object} opts.supabase
 * @param {number} opts.company_id
 * @param {number|null} opts.cliente_id
 * @param {string|null} opts.telefone - usado quando cliente_id é null (LID)
 * @param {string} opts.texto
 * @returns {Promise<{ isOptOut: boolean, mensagemConfirmacao?: string }>}
 */
async function processarOptOut({ supabase, company_id, cliente_id, telefone, texto }) {
  if (!isOptOutCommand(texto)) return { isOptOut: false }
  if (!cliente_id && !telefone) return { isOptOut: false }

  try {
    let q = supabase.from('contato_opt_out').select('id').eq('company_id', company_id)
    if (cliente_id) q = q.eq('cliente_id', cliente_id)
    else if (telefone) q = q.eq('telefone', telefone)
    else return { isOptOut: false }
    const { data: rows } = await q.limit(1)

    if (rows && rows.length > 0) {
      return { isOptOut: true, mensagemConfirmacao: 'Você já está descadastrado. Não enviaremos mais mensagens comerciais.' }
    }

    await supabase.from('contato_opt_out').insert({
      company_id,
      cliente_id: cliente_id || null,
      telefone: cliente_id ? null : (telefone || null),
      motivo: 'comando_chat',
      canal: 'whatsapp',
    })

    await supabase.from('bot_logs').insert({
      company_id,
      conversa_id: null,
      tipo: 'opt_out',
      detalhes: { cliente_id: cliente_id || null, telefone: telefone || null },
    }).catch(() => {})

    return {
      isOptOut: true,
      mensagemConfirmacao: 'Você foi descadastrado com sucesso. Não enviaremos mais mensagens comerciais.',
    }
  } catch (e) {
    console.warn('[optOutService] Erro ao processar opt-out:', e?.message || e)
    return { isOptOut: false }
  }
}

/**
 * Verifica se contato está em opt-out (para campanhas).
 * @param {object} supabase
 * @param {number} company_id
 * @param {number|null} cliente_id
 * @param {string|null} telefone
 */
async function verificarOptOut(supabase, company_id, cliente_id, telefone) {
  if (!cliente_id && !telefone) return false
  let q = supabase.from('contato_opt_out').select('id').eq('company_id', company_id)
  if (cliente_id) q = q.eq('cliente_id', cliente_id)
  else q = q.eq('telefone', telefone)
  const { data } = await q.limit(1)
  return !!(data && data.length > 0)
}

module.exports = {
  verificarOptOut,
  processarOptOut,
  isOptOutCommand,
  COMANDOS_OPT_OUT,
}
