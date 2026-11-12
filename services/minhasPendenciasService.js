const supabase = require('../config/supabase')
const { instanciasPermitidasDoUsuario, atendentePodeVerNumero } = require('./chat/access/usuarioWhatsappInstanceAccess')
const { listUltimaMensagemPorConversa } = require('./chat/read/ultimaMensagemPorConversa')

async function loadWhatsappInstanceMetaMap(companyId, instanceIds) {
  const ids = [...new Set((instanceIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))]
  if (!ids.length) return new Map()
  const { data, error } = await supabase
    .from('whatsapp_instances')
    .select('id, nome, display_phone')
    .eq('company_id', Number(companyId))
    .in('id', ids)
  if (error) return new Map()
  return new Map(
    (data || []).map((row) => [
      Number(row.id),
      {
        whatsapp_instance_id: row.id,
        whatsapp_instance_nome: row.nome ?? null,
        whatsapp_instance_display_phone: row.display_phone ?? null,
      },
    ])
  )
}

function metaFromMap(metaMap, conversa) {
  const id = Number(conversa?.whatsapp_instance_id)
  return metaMap.get(id) || { whatsapp_instance_id: conversa?.whatsapp_instance_id ?? null }
}

const DELAY_MINUTES = 30
const MSG_PAGE = 1000
const CONV_ID_IN_CHUNK = 120

/** Status que encerram ou retiram a conversa das pendências do atendente. */
const EXCLUDED_STATUSES = new Set([
  'fechada',
  'finalizada',
  'aguardando_cliente',
  'mensagem_disparada',
])

const CATEGORIAS = {
  transferidosParaVoce: 'transferidosParaVoce',
  aguardandoSuaResposta: 'aguardandoSuaResposta',
  emAtraso: 'emAtraso',
}

function minutesSince(isoDate) {
  if (!isoDate) return 0
  const diff = Date.now() - new Date(isoDate).getTime()
  return Math.max(0, Math.floor(diff / 60000))
}

function isAguardandoCliente(conversa) {
  const status = String(conversa?.status_atendimento || '').toLowerCase()
  if (status === 'aguardando_cliente') return true
  if (status === 'em_atendimento' && conversa?.aguardando_cliente_desde != null) return true
  return false
}

function isFinalizadaOuAusencia(conversa) {
  const status = String(conversa?.status_atendimento || '').toLowerCase()
  if (EXCLUDED_STATUSES.has(status)) return true
  if (status === 'fechada') {
    const motivo = String(conversa?.finalizacao_motivo || '').toLowerCase()
    if (motivo === 'ausencia_cliente') return true
    if (conversa?.finalizada_automaticamente) return true
  }
  return false
}

function isConversaElegivelBase(conversa, usuarioId) {
  if (!conversa || conversa.tipo === 'grupo') return false
  if (conversa.atendente_id == null) return false
  if (Number(conversa.atendente_id) !== Number(usuarioId)) return false
  if (isAguardandoCliente(conversa)) return false
  if (isFinalizadaOuAusencia(conversa)) return false
  return String(conversa.status_atendimento || '').toLowerCase() === 'em_atendimento'
}

/**
 * Última transferência recebida pelo usuário logado (por conversa).
 * Map<conversa_id, { criado_em, id }>
 */
function buildUltimaTransferenciaRecebidaMap(rows, usuarioId) {
  const uid = Number(usuarioId)
  const map = new Map()
  for (const row of rows || []) {
    if (String(row.acao || '').toLowerCase() !== 'transferiu') continue
    if (Number(row.para_usuario_id) !== uid) continue
    const cid = Number(row.conversa_id)
    if (!Number.isFinite(cid) || cid <= 0) continue
    const ts = row.criado_em ? new Date(row.criado_em).getTime() : 0
    const prev = map.get(cid)
    if (!prev || ts >= new Date(prev.criado_em).getTime()) {
      map.set(cid, { criado_em: row.criado_em, id: row.id })
    }
  }
  return map
}

/**
 * Conversas em que o atendente já respondeu após a última transferência recebida.
 */
function buildRespostaAposTransferenciaSet(mensagens, transferMap, usuarioId) {
  const uid = Number(usuarioId)
  const responded = new Set()
  for (const msg of mensagens || []) {
    if (msg.direcao !== 'out') continue
    if (Number(msg.autor_usuario_id) !== uid) continue
    const cid = Number(msg.conversa_id)
    const transfer = transferMap.get(cid)
    if (!transfer?.criado_em || !msg.criado_em) continue
    if (new Date(msg.criado_em).getTime() >= new Date(transfer.criado_em).getTime()) {
      responded.add(cid)
    }
  }
  return responded
}

function isTransferidoParaVoce(conversa, transferMap, respostaAposTransferencia, usuarioId) {
  if (!isConversaElegivelBase(conversa, usuarioId)) return false
  const cid = Number(conversa.id)
  if (!transferMap.has(cid)) return false
  if (respostaAposTransferencia.has(cid)) return false
  return true
}

function isAguardandoSuaResposta(conversa, lastMessage, usuarioId) {
  if (!isConversaElegivelBase(conversa, usuarioId)) return false
  if (!lastMessage || lastMessage.direcao !== 'in') return false
  return true
}

function isEmAtraso(conversa, lastMessage, usuarioId) {
  if (!isAguardandoSuaResposta(conversa, lastMessage, usuarioId)) return false
  return minutesSince(lastMessage.criado_em) > DELAY_MINUTES
}

function toListItem(conversa, instanceMeta = {}) {
  return {
    conversa_id: Number(conversa.id),
    telefone: conversa.telefone ?? null,
    status_atendimento: conversa.status_atendimento ?? null,
    atendente_id: conversa.atendente_id != null ? Number(conversa.atendente_id) : null,
    ultima_atividade: conversa.ultima_atividade ?? null,
    whatsapp_instance_id: conversa.whatsapp_instance_id ?? instanceMeta.whatsapp_instance_id ?? null,
    whatsapp_instance_nome: instanceMeta.whatsapp_instance_nome ?? null,
    whatsapp_instance_display_phone: instanceMeta.whatsapp_instance_display_phone ?? null,
  }
}

/**
 * Última mensagem in/out por conversa — embed lateral `limit 1` por conversa, sem OFFSET
 * (doc 29 §3 item 10; implementação partilhada com a Supervisão em
 * `services/chat/read/ultimaMensagemPorConversa.js`). Map<Number(conversa_id), linha>.
 */
async function listLastMessagesByConversation(companyId, conversationIds) {
  return listUltimaMensagemPorConversa(companyId, conversationIds, {
    colunas: 'conversa_id, direcao, criado_em',
  })
}

async function listConversasDoAtendente(companyId, usuarioId) {
  const all = []
  let offset = 0
  for (;;) {
    const { data, error } = await supabase
      .from('conversas')
      .select(`
        id,
        company_id,
        telefone,
        tipo,
        status_atendimento,
        atendente_id,
        atendente_atribuido_em,
        aguardando_cliente_desde,
        finalizacao_motivo,
        finalizada_automaticamente,
        ultima_atividade,
        whatsapp_instance_id
      `)
      .eq('company_id', companyId)
      .eq('atendente_id', usuarioId)
      .eq('status_atendimento', 'em_atendimento')
      .or('tipo.is.null,tipo.neq.grupo')
      .order('ultima_atividade', { ascending: false, nullsFirst: false })
      .range(offset, offset + MSG_PAGE - 1)
    if (error) throw error
    const rows = data || []
    all.push(...rows)
    if (rows.length < MSG_PAGE) break
    offset += MSG_PAGE
  }
  return all
}

async function listTransferenciasRecebidas(companyId, conversaIds, usuarioId) {
  const ids = [...new Set(
    (conversaIds || []).map((id) => Number(id)).filter((n) => Number.isFinite(n) && n > 0)
  )]
  if (!ids.length) return []

  const all = []
  for (let i = 0; i < ids.length; i += CONV_ID_IN_CHUNK) {
    const slice = ids.slice(i, i + CONV_ID_IN_CHUNK)
    const { data, error } = await supabase
      .from('atendimentos')
      .select('id, conversa_id, acao, criado_em, para_usuario_id')
      .eq('company_id', companyId)
      .in('conversa_id', slice)
      .eq('acao', 'transferiu')
      .eq('para_usuario_id', usuarioId)
      .order('criado_em', { ascending: false })
    if (error) throw error
    all.push(...(data || []))
  }
  return all
}

/** Menor `criado_em` entre as transferências do lote — fronteira da janela de data. */
function transferenciaMaisAntigaIso(conversaIdsSlice, transferMap) {
  let min = Infinity
  for (const cid of conversaIdsSlice) {
    const t = transferMap.get(Number(cid))?.criado_em
    if (!t) continue
    const ts = new Date(t).getTime()
    if (Number.isFinite(ts) && ts < min) min = ts
  }
  return Number.isFinite(min) ? new Date(min).toISOString() : null
}

/**
 * ÚLTIMA resposta (`out`) do atendente logado em cada conversa que lhe foi transferida.
 *
 * Doc 29 §3 item 10: a versão antiga trazia TODAS as mensagens `out` do usuário nessas
 * conversas, sem janela de data nem teto — e o PostgREST corta em ~1000 linhas em silêncio,
 * logo um atendente com histórico longo podia ver "transferido para você" voltar numa
 * conversa já respondida.
 *
 * Por que UMA linha por conversa basta: `buildRespostaAposTransferenciaSet` só pergunta
 * "existe `out` do usuário com criado_em >= transferência?". A última `out` do usuário tem o
 * maior criado_em, logo "última >= transferência" ⇔ "existe alguma >= transferência".
 *
 * Janela de data: nenhuma mensagem anterior à transferência MAIS ANTIGA do lote pode
 * satisfazer o critério acima (cada conversa exige criado_em >= a SUA transferência, que é
 * >= a mais antiga). O `gte` só corta o que o classificador ignoraria — mesmo resultado.
 * (Minhas Pendências não tem "período": conversas `em_atendimento` contam seja a
 * transferência de hoje ou da semana passada, por isso a fronteira é a transferência e não
 * o início do dia.)
 *
 * Teto: o pai é `.in('id', slice)` com <= CONV_ID_IN_CHUNK ids e o embed devolve <= 1 linha
 * por conversa, logo o resultado real tem no máximo `slice.length` linhas —
 * `limit(slice.length)` é o teto exato e nunca trunca.
 *
 * Formato de retorno inalterado: linhas planas `{ conversa_id, direcao, criado_em,
 * autor_usuario_id }` (no máximo uma por conversa).
 */
async function listRespostasAtendenteAposTransferencias(companyId, conversaIds, usuarioId, transferMap) {
  const idsComTransfer = [...transferMap.keys()]
  if (!idsComTransfer.length) return []

  const all = []
  for (let i = 0; i < idsComTransfer.length; i += CONV_ID_IN_CHUNK) {
    const slice = idsComTransfer.slice(i, i + CONV_ID_IN_CHUNK)
    const desde = transferenciaMaisAntigaIso(slice, transferMap)
    // Sem data válida em nenhuma transferência do lote, o classificador ignora todas
    // (`if (!transfer?.criado_em) continue`) — não há resposta possível a devolver.
    if (!desde) continue

    const { data, error } = await supabase
      .from('conversas')
      .select('id, mensagens ( conversa_id, direcao, criado_em, autor_usuario_id )')
      .eq('company_id', companyId)
      .in('id', slice)
      .eq('mensagens.company_id', companyId)
      .eq('mensagens.direcao', 'out')
      .eq('mensagens.autor_usuario_id', usuarioId)
      .not('mensagens.criado_em', 'is', null)
      .gte('mensagens.criado_em', desde)
      .order('criado_em', { ascending: false, referencedTable: 'mensagens' })
      .order('id', { ascending: false, referencedTable: 'mensagens' })
      .limit(1, { referencedTable: 'mensagens' })
      .limit(slice.length)
    if (error) throw error

    for (const conversa of data || []) {
      const ultima = Array.isArray(conversa?.mensagens) ? conversa.mensagens[0] : conversa?.mensagens
      if (!ultima) continue
      all.push({ ...ultima, conversa_id: Number(conversa.id) })
    }
  }
  return all
}

function classificarPendencias(conversas, { usuarioId, lastMessagesMap, transferMap, respostaAposTransferencia }) {
  const transferidos = []
  const aguardandoResposta = []
  const emAtraso = []

  for (const conversa of conversas) {
    const cid = Number(conversa.id)
    const lastMessage = lastMessagesMap.get(cid) || null

    if (isTransferidoParaVoce(conversa, transferMap, respostaAposTransferencia, usuarioId)) {
      transferidos.push(conversa)
    }

    if (isAguardandoSuaResposta(conversa, lastMessage, usuarioId)) {
      aguardandoResposta.push(conversa)
      if (isEmAtraso(conversa, lastMessage, usuarioId)) {
        emAtraso.push(conversa)
      }
    }
  }

  return { transferidos, aguardandoResposta, emAtraso }
}

async function computeMinhasPendencias(companyId, usuarioId) {
  const cid = Number(companyId)
  const uid = Number(usuarioId)
  if (!Number.isFinite(cid) || cid <= 0) throw Object.assign(new Error('company_id inválido'), { statusCode: 400 })
  if (!Number.isFinite(uid) || uid <= 0) throw Object.assign(new Error('usuario_id inválido'), { statusCode: 400 })

  const conversasRaw = await listConversasDoAtendente(cid, uid)
  const permitidas = await instanciasPermitidasDoUsuario(cid, uid)
  const conversas = conversasRaw.filter(
    (c) => isConversaElegivelBase(c, uid) && atendentePodeVerNumero(permitidas, c.whatsapp_instance_id)
  )
  const conversaIds = conversas.map((c) => c.id)

  const [lastMessagesMap, transferRows] = await Promise.all([
    listLastMessagesByConversation(cid, conversaIds),
    listTransferenciasRecebidas(cid, conversaIds, uid),
  ])

  const transferMap = buildUltimaTransferenciaRecebidaMap(transferRows, uid)
  const mensagensResposta = await listRespostasAtendenteAposTransferencias(
    cid,
    conversaIds,
    uid,
    transferMap
  )
  const respostaAposTransferencia = buildRespostaAposTransferenciaSet(
    mensagensResposta,
    transferMap,
    uid
  )

  return classificarPendencias(conversas, {
    usuarioId: uid,
    lastMessagesMap,
    transferMap,
    respostaAposTransferencia,
  })
}

async function getMinhasPendenciasResumo(companyId, usuarioId) {
  const { transferidos, aguardandoResposta, emAtraso } = await computeMinhasPendencias(companyId, usuarioId)
  return {
    transferidosParaVoce: transferidos.length,
    aguardandoSuaResposta: aguardandoResposta.length,
    emAtraso: emAtraso.length,
  }
}

async function getMinhasPendenciasPorCategoria(companyId, usuarioId, categoria) {
  const key = String(categoria || '').trim()
  if (!CATEGORIAS[key]) {
    throw Object.assign(
      new Error('categoria inválida. Use: transferidosParaVoce, aguardandoSuaResposta ou emAtraso'),
      { statusCode: 400 }
    )
  }

  const { transferidos, aguardandoResposta, emAtraso } = await computeMinhasPendencias(companyId, usuarioId)

  let lista = []
  if (key === CATEGORIAS.transferidosParaVoce) lista = transferidos
  else if (key === CATEGORIAS.aguardandoSuaResposta) lista = aguardandoResposta
  else lista = emAtraso

  const metaMap = await loadWhatsappInstanceMetaMap(companyId, lista.map((c) => c.whatsapp_instance_id))

  return {
    categoria: key,
    total: lista.length,
    conversa_ids: lista.map((c) => Number(c.id)),
    itens: lista.map((c) => toListItem(c, metaFromMap(metaMap, c))),
  }
}

module.exports = {
  getMinhasPendenciasResumo,
  getMinhasPendenciasPorCategoria,
  CATEGORIAS,
  // exportados para testes unitários da classificação
  _test: {
    listLastMessagesByConversation,
    listRespostasAtendenteAposTransferencias,
    transferenciaMaisAntigaIso,
    isAguardandoCliente,
    isConversaElegivelBase,
    buildUltimaTransferenciaRecebidaMap,
    buildRespostaAposTransferenciaSet,
    isTransferidoParaVoce,
    isAguardandoSuaResposta,
    isEmAtraso,
    classificarPendencias,
    minutesSince,
    DELAY_MINUTES,
  },
}
