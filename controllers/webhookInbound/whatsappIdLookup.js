/**
 * Consulta/atualização de mensagem por whatsapp_id com filtro de instância (e fallback legado sem instância).
 * Extraído de controllers/webhookZapiController.js (Fase 2 — doc 24) sem alteração de comportamento.
 * As funções recebem o supabaseClient por parâmetro (não importam supabase).
 */

const {
  statusesQueBloqueiamGravacao,
  gravacaoDeStatusBloqueada,
  statusRank,
} = require('../../helpers/messageStatusHelper')
const { erroDeMarcoAusente, desligarMarcos, marcosDisponiveis } = require('../../helpers/ackMilestoneColumns')

/**
 * Horário de entrega/leitura (F9 do doc 33) — colunas `entregue_em` / `lida_em`.
 *
 * Só grava quando o status REALMENTE avança para aquele nível. Isso dá "escreve uma vez" sem
 * precisar ler as colunas: ACK reentregue (a Whapi reentrega statuses no reconnect) não avança
 * nada, então não reescreve o horário — quem chegou primeiro manda. Leitura implica entrega, por
 * isso um salto pending→read grava os dois.
 *
 * `statusAtual` ausente ⇒ nenhum marco. O chamador que não sabe o status atual não pode cravar
 * horário; nulo significa "sem informação", e isso é mais honesto que um horário chutado.
 */
function marcosDeAck(statusAtual, statusNovo, agoraIso) {
  if (statusAtual == null || String(statusAtual).trim() === '') return {}
  const de = statusRank(statusAtual)
  const para = statusRank(statusNovo)
  if (!(para > de)) return {}
  const agora = agoraIso || new Date().toISOString()
  const marcos = {}
  if (de < statusRank('delivered') && para >= statusRank('delivered')) marcos.entregue_em = agora
  if (de < statusRank('read') && para >= statusRank('read')) marcos.lida_em = agora
  return marcos
}

/**
 * Migration `20261016120000_mensagens_entregue_lida_em` aplicada? A detecção é COMPARTILHADA com
 * os selects de mensagens (`helpers/ackMilestoneColumns`) — uma fonte só, para a coluna não ser
 * considerada ausente num lugar e presente no outro. Código novo com migration pendente NÃO pode
 * derrubar o ACK (e, com o F4, um erro aqui viraria 500 e rajada de reentrega).
 */

const WEBHOOK_MSG_SELECT = 'id, conversa_id, company_id, whatsapp_instance_id, whatsapp_id, texto, url, tipo, direcao, criado_em, status, autor_usuario_id, reply_meta, nome_arquivo, contact_meta, location_meta, remetente_nome, remetente_telefone'

/** URL pública remota (CDN UltraMsg) — diferente de /uploads/ gravado pelo CRM no envio. */
function isTraceableWhatsappMessageId(value) {
  if (!value) return false
  const s = String(value).trim()
  if (!s || s === 'null' || s === 'undefined' || s === 'false' || s === '0') return false
  if (s.includes('@')) return true
  if (/^[A-F0-9]{12,}$/i.test(s)) return true
  if (s.length > 20) return true
  return false
}

function isRemoteMediaUrl(url) {
  const u = String(url || '').trim().toLowerCase()
  return u.startsWith('http://') || u.startsWith('https://')
}

function isLocalUploadMediaUrl(url) {
  return String(url || '').trim().startsWith('/uploads/')
}

/**
 * No fallback de insert (erro de schema), nunca descartar tipo/url/nome da mídia já montados.
 * Mutates and returns fallbackPayload.
 */
function preserveMediaFieldsOnWebhookFallback(fallbackPayload, insertMsg) {
  if (!fallbackPayload || !insertMsg || typeof insertMsg !== 'object') return fallbackPayload
  if (insertMsg.tipo) fallbackPayload.tipo = insertMsg.tipo
  if (insertMsg.url) fallbackPayload.url = insertMsg.url
  if (insertMsg.nome_arquivo) fallbackPayload.nome_arquivo = insertMsg.nome_arquivo
  return fallbackPayload
}

function applyWhatsappInstanceFilter(query, whatsappInstanceId) {
  if (!query || !whatsappInstanceId) return query
  return query.eq('whatsapp_instance_id', whatsappInstanceId)
}

function applyWhatsappInstanceFilterOrLegacy(query, whatsappInstanceId) {
  if (!query) return query
  if (whatsappInstanceId) return query.eq('whatsapp_instance_id', whatsappInstanceId)
  return query.is('whatsapp_instance_id', null)
}

function logAmbiguousWhatsappId(context, { company_id, whatsapp_instance_id, whatsapp_id, count, conversa_ids }) {
  console.error('[webhook] whatsapp_id ambiguo; bloqueando atualizacao para evitar mistura multi-instancia', {
    context,
    company_id,
    whatsapp_instance_id: whatsapp_instance_id || null,
    whatsapp_id: whatsapp_id ? String(whatsapp_id).slice(0, 32) : null,
    count,
    conversa_ids: conversa_ids || undefined,
  })
}

async function selectSingleMensagemByWhatsappId(
  supabaseClient,
  { company_id, whatsapp_id, whatsapp_instance_id = null, select = WEBHOOK_MSG_SELECT, context = 'webhook' }
) {
  const waId = whatsapp_id != null ? String(whatsapp_id).trim() : ''
  if (!supabaseClient || !company_id || !waId) return { data: null, error: null, ambiguous: false }

  // Inclui conversa_id na busca interna para diagnóstico de ambiguidade e dedup por conversa.
  const internalSelect = select.includes('conversa_id') ? select : `${select}, conversa_id`
  let query = supabaseClient
    .from('mensagens')
    .select(internalSelect)
    .eq('company_id', company_id)
    .eq('whatsapp_id', waId)
    .order('id', { ascending: false })
    .limit(2)
  query = applyWhatsappInstanceFilterOrLegacy(query, whatsapp_instance_id)

  const { data, error } = await query
  if (error) return { data: null, error, ambiguous: false }
  const rows = Array.isArray(data) ? data : []
  if (rows.length > 1) {
    // Se ambas as linhas pertencem à mesma conversa, é reentrega dupla — usar a mais recente (id maior).
    const conversaIds = rows.map((r) => r.conversa_id)
    const allSameConversa = conversaIds.every((c) => c != null && c === conversaIds[0])
    if (allSameConversa) {
      return { data: rows[0], error: null, ambiguous: false }
    }
    logAmbiguousWhatsappId(context, {
      company_id,
      whatsapp_instance_id,
      whatsapp_id: waId,
      count: rows.length,
      conversa_ids: conversaIds,
    })
    return {
      data: null,
      error: { code: 'AMBIGUOUS_WHATSAPP_ID', message: 'whatsapp_id ambiguo para a empresa/instancia' },
      ambiguous: true,
    }
  }
  return { data: rows[0] || null, error: null, ambiguous: false }
}

/**
 * Com `guardarRegressaoDeStatus: true` (caminho de ACK) a gravação passa por
 * `patchMensagemStatusById` e herda a guarda atômica de não-regressão — inclusive o
 * `bloqueadoPorRegressao` no retorno. Sem a flag, grava como sempre (ex.: edição de texto em
 * `persistMensagem`, que não é status e não pode ganhar guarda nenhuma).
 */
async function updateSingleMensagemByWhatsappId(
  supabaseClient,
  {
    company_id,
    whatsapp_id,
    whatsapp_instance_id = null,
    updates,
    select = WEBHOOK_MSG_SELECT,
    context = 'webhook',
    guardarRegressaoDeStatus = false,
  }
) {
  const found = await selectSingleMensagemByWhatsappId(supabaseClient, {
    company_id,
    whatsapp_id,
    whatsapp_instance_id,
    select: 'id, whatsapp_id',
    context,
  })
  if (found.error || !found.data?.id) return { data: null, error: found.error || null, ambiguous: Boolean(found.ambiguous) }

  if (guardarRegressaoDeStatus === true && updates?.status != null) {
    const patched = await patchMensagemStatusById(supabaseClient, {
      company_id,
      mensagem_id: found.data.id,
      effectiveStatus: updates.status,
      whatsapp_id: updates.whatsapp_id,
      select,
    })
    return {
      data: patched.data,
      error: patched.error,
      ambiguous: false,
      bloqueadoPorRegressao: Boolean(patched.bloqueadoPorRegressao),
    }
  }

  const { data, error } = await supabaseClient
    .from('mensagens')
    .update(updates)
    .eq('company_id', company_id)
    .eq('id', found.data.id)
    .select(select)
    .maybeSingle()
  return { data, error, ambiguous: false }
}

/** Busca mensagem por whatsapp_id sem filtrar instância (fallback quando ACK não encontra por instance_id). */
async function selectSingleMensagemByWhatsappIdRelaxed(
  supabaseClient,
  { company_id, whatsapp_id, select = 'id, conversa_id, company_id, autor_usuario_id, whatsapp_id, status, whatsapp_instance_id', context = 'webhook' }
) {
  const waId = whatsapp_id != null ? String(whatsapp_id).trim() : ''
  if (!supabaseClient || !company_id || !waId) return { data: null, ambiguous: false }

  const { data, error } = await supabaseClient
    .from('mensagens')
    .select(select)
    .eq('company_id', company_id)
    .eq('whatsapp_id', waId)
    .order('id', { ascending: false })
    .limit(2)
  if (error) return { data: null, ambiguous: false, error }
  const rows = Array.isArray(data) ? data : []
  if (rows.length > 1) {
    logAmbiguousWhatsappId(context, { company_id, whatsapp_instance_id: null, whatsapp_id: waId, count: rows.length })
    return { data: null, ambiguous: true }
  }
  return { data: rows[0] || null, ambiguous: false }
}

/** Garante `status` no select: o chamador precisa saber o que FICOU gravado (ver guarda abaixo). */
function withStatusNoSelect(select) {
  const base = select || 'id, conversa_id, company_id, autor_usuario_id, whatsapp_id'
  return /(^|,)\s*status\s*(,|$)/.test(base) ? base : `${base}, status`
}

/**
 * Grava o status da mensagem por id, SEM rebaixar o tique por corrida (F3 do doc 33).
 *
 * O UPDATE leva a guarda `status NOT IN (<apelidos mais avançados>)`, então a decisão é atômica:
 * dois ACKs concorrentes (`delivered` e `read` chegando em POSTs paralelos) não conseguem mais
 * gravar na ordem errada — antes os dois liam `sent` e o último a gravar vencia.
 *
 * Quando a guarda não casa nenhuma linha, NÃO assumimos regressão: relemos a linha e só tratamos
 * como bloqueio se o status gravado for de fato mais avançado. Linha com `status` NULL ou valor
 * desconhecido (que o `NOT IN` não casa) cai na gravação sem guarda — comportamento de antes.
 * Assim a guarda pode custar uma consulta extra, mas nunca perder um ACK.
 *
 * Retorna `{ data, error, bloqueadoPorRegressao }`. Com `bloqueadoPorRegressao: true`, `data` é a
 * linha como está no banco (status do ACK vencedor) — o chamador deve emitir ESSE status, não o seu.
 */
async function patchMensagemStatusById(
  supabaseClient,
  { company_id, mensagem_id, effectiveStatus, whatsapp_id, select, guardarRegressao = true, statusAtual = null }
) {
  const updates = { status: effectiveStatus, status_mensagem: effectiveStatus }
  if (whatsapp_id) updates.whatsapp_id = whatsapp_id
  const marcos = marcosDeAck(statusAtual, effectiveStatus)
  const selectComStatus = withStatusNoSelect(select)

  const gravar = (comGuarda, comMarcos = true) => {
    const corpo = comMarcos && marcosDisponiveis() ? { ...updates, ...marcos } : updates
    let q = supabaseClient
      .from('mensagens')
      .update(corpo)
      .eq('company_id', company_id)
      .eq('id', mensagem_id)
    if (comGuarda) {
      const bloqueiam = statusesQueBloqueiamGravacao(effectiveStatus)
      if (bloqueiam.length) q = q.not('status', 'in', `(${bloqueiam.join(',')})`)
    }
    return q.select(selectComStatus).maybeSingle()
  }

  /** Migration pendente: desliga os marcos e regrava só o status (nunca perde o ACK). */
  const gravarTolerante = async (comGuarda) => {
    const r = await gravar(comGuarda)
    if (r.error && erroDeMarcoAusente(r.error)) {
      desligarMarcos()
      return gravar(comGuarda, false)
    }
    return r
  }

  const usarGuarda = guardarRegressao === true && Boolean(effectiveStatus) &&
    statusesQueBloqueiamGravacao(effectiveStatus).length > 0
  const marcosGravados = () => (marcosDisponiveis() ? marcos : {})
  if (!usarGuarda) {
    const { data, error } = await gravarTolerante(false)
    return { data, error, bloqueadoPorRegressao: false, marcos: error ? {} : marcosGravados() }
  }

  const primeira = await gravarTolerante(true)
  if (primeira.error || primeira.data) {
    return {
      data: primeira.data,
      error: primeira.error,
      bloqueadoPorRegressao: false,
      marcos: primeira.error ? {} : marcosGravados(),
    }
  }

  // Nada casou: ou a linha não existe, ou está num status que a guarda barrou, ou o status é
  // NULL/desconhecido (fora da lista do NOT IN).
  const { data: atual, error: erroLeitura } = await supabaseClient
    .from('mensagens')
    .select(selectComStatus)
    .eq('company_id', company_id)
    .eq('id', mensagem_id)
    .maybeSingle()
  if (erroLeitura) return { data: null, error: erroLeitura, bloqueadoPorRegressao: false, marcos: {} }
  if (!atual) return { data: null, error: null, bloqueadoPorRegressao: false, marcos: {} }

  if (gravacaoDeStatusBloqueada(atual.status, effectiveStatus)) {
    console.log('[webhook] ACK concorrente ignorado para não rebaixar o tique', {
      company_id,
      mensagem_id,
      status_gravado: atual.status,
      status_do_ack: effectiveStatus,
    })
    return { data: atual, error: null, bloqueadoPorRegressao: true, marcos: {} }
  }

  // Sem regressão de verdade (NULL/valor fora da lista): grava como antes da guarda existir.
  const segunda = await gravarTolerante(false)
  return {
    data: segunda.data,
    error: segunda.error,
    bloqueadoPorRegressao: false,
    marcos: segunda.error ? {} : marcosGravados(),
  }
}

module.exports = {
  marcosDeAck,
  _marcosDeAck: {
    desligados: () => !marcosDisponiveis(),
    religar: () => require('../../helpers/ackMilestoneColumns')._test.religar(),
  },
  isTraceableWhatsappMessageId,
  isRemoteMediaUrl,
  isLocalUploadMediaUrl,
  preserveMediaFieldsOnWebhookFallback,
  applyWhatsappInstanceFilter,
  applyWhatsappInstanceFilterOrLegacy,
  logAmbiguousWhatsappId,
  selectSingleMensagemByWhatsappId,
  updateSingleMensagemByWhatsappId,
  selectSingleMensagemByWhatsappIdRelaxed,
  patchMensagemStatusById,
}
