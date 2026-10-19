'use strict'

/**
 * Sincronização da EXCLUSÃO de conversa entre ZapERP e WhatsApp — direção WhatsApp → ZapERP.
 *
 * A direção ZapERP → WhatsApp já existe em controllers/chat/conversationCleanupController.js
 * (`apagarChatNoWhatsapp` → provider.deleteChat). Este módulo cobre o inverso e a guarda
 * anti-loop entre os dois.
 *
 * O QUE CADA PROVEDOR PERMITE (verificado na documentação oficial, 2026-10-19 — não inventar):
 * - Whapi: apagar = `DELETE /chats/{ChatID}` (já no adapter). Webhook de exclusão = evento
 *   `chats` método `delete`, com corpo `{ chats_removed: ["<jid>"], event: {type:'chats',
 *   event:'delete'}, channel_id }`. É o único provedor que AVISA quando o chat é apagado no
 *   celular. O canal precisa assinar o evento (WHAPI_WEBHOOK_EVENTS em whapi/instanceAdmin.js).
 * - UltraMSG: apagar = `POST /{instance}/chats/delete` {token, chatId} (já no adapter). Webhook
 *   NÃO tem evento de chat apagado — as notificações da instância cobrem só mensagem recebida,
 *   mensagem criada e ACK. Logo, "apaguei no celular" é INVISÍVEL para o webhook UltraMSG.
 *   Melhor solução possível: reconciliação sob demanda contra `GET /{instance}/chats`
 *   (`reconciliarExclusoesDeChats`), conservadora e por padrão em simulação.
 *
 * ANTI-LOOP: toda exclusão feita no ZapERP registra a identidade do chat aqui
 * (`registrarExclusaoLocal`). O eco que o provedor manda de volta ("chat X foi removido")
 * cai na guarda e não dispara nova exclusão. Além disso, a exclusão vinda do WhatsApp NUNCA
 * chama provider.deleteChat — a cascata usada é a do núcleo, que não fala com o provedor.
 */

const supabase = require('../../../config/supabase')
const { possiblePhonesForWhatsappIdentity } = require('../../../helpers/phoneHelper')
const { listWhatsappInstances } = require('../../whatsappInstanceService')
const {
  apagarDependenciasEConversa,
  emitirConversaApagada,
} = require('../deletion/conversationDeletionService')

// =====================================================================================
// Flags de operação
// =====================================================================================

function envBool(name, padrao) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase()
  if (!raw) return padrao
  if (['1', 'true', 'yes', 'sim', 'on'].includes(raw)) return true
  if (['0', 'false', 'no', 'nao', 'não', 'off'].includes(raw)) return false
  return padrao
}

function envInt(name, padrao) {
  const n = Number(String(process.env[name] ?? '').trim())
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : padrao
}

/** Chave mestra: desligar para parar de aplicar exclusões vindas do WhatsApp. */
function syncEntradaHabilitado() {
  return envBool('WHATSAPP_CHAT_DELETE_SYNC_INBOUND', true)
}

/**
 * Teto de exclusões por lote de webhook. O Whapi pode reentregar backlog ou mandar um
 * `chats_removed` grande num resync de canal; apagar 300 conversas de uma vez por causa de
 * um resync é dano irreversível. Acima do teto o lote inteiro é recusado e logado para
 * decisão humana (a reconciliação manual continua disponível).
 */
function tetoExclusoesPorLote() {
  return envInt('WHATSAPP_CHAT_DELETE_SYNC_MAX_BATCH', 5)
}

// =====================================================================================
// Guarda anti-loop (eco do provedor)
// =====================================================================================

const ECO_TTL_MS = 10 * 60 * 1000
const ECO_MAX = 2000
const _ecoRecentes = new Map()

function _ecoKey(companyId, identidade) {
  return `${Number(companyId)}:${String(identidade)}`
}

function _ecoPrune(agora = Date.now()) {
  for (const [k, at] of _ecoRecentes) {
    if (!at || agora - at > ECO_TTL_MS) _ecoRecentes.delete(k)
  }
}

/**
 * Registra que o ZapERP acabou de apagar este chat (e pediu ao provedor que apagasse).
 * O eco do provedor (webhook chats.delete) dentro da janela é ignorado.
 * `telefoneOuJid` aceita telefone em dígitos, `lid:...`, `...@s.whatsapp.net`, `...@c.us`.
 */
function registrarExclusaoLocal({ company_id, telefone } = {}) {
  const identidade = chaveIdentidadeDeChat(telefone)
  if (!identidade) return
  const cid = Number(company_id)
  if (!Number.isFinite(cid) || cid <= 0) return
  _ecoPrune()
  if (_ecoRecentes.size >= ECO_MAX) {
    const maisAntiga = _ecoRecentes.keys().next().value
    if (maisAntiga !== undefined) _ecoRecentes.delete(maisAntiga)
  }
  // Registra TODAS as variantes de identidade (±9º dígito): o provedor pode ecoar o JID na
  // forma de 12 dígitos quando apagamos pela de 13 (ou o contrário).
  for (const variante of variantesDeIdentidade(identidade)) {
    _ecoRecentes.set(_ecoKey(cid, variante), Date.now())
  }
}

/** Esta exclusão remota é só o eco de uma exclusão que nós mesmos fizemos? */
function foiExclusaoLocalRecente({ company_id, telefone } = {}) {
  const identidade = chaveIdentidadeDeChat(telefone)
  if (!identidade) return false
  const cid = Number(company_id)
  if (!Number.isFinite(cid) || cid <= 0) return false
  for (const variante of variantesDeIdentidade(identidade)) {
    const at = _ecoRecentes.get(_ecoKey(cid, variante))
    if (!at) continue
    if (Date.now() - at <= ECO_TTL_MS) return true
    _ecoRecentes.delete(_ecoKey(cid, variante))
  }
  return false
}

// =====================================================================================
// Identidade do chat (NUNCA por nome do contato)
// =====================================================================================

/**
 * Normaliza qualquer endereço de chat para a chave de identidade usada aqui:
 * - grupo            → `<id>@g.us` (preservado)
 * - endereço LID     → `lid:<dígitos>`
 * - contato normal   → só os dígitos (`5534999887766`)
 * Nome do contato nunca participa — o casamento é por company_id + instância + identidade.
 */
function chaveIdentidadeDeChat(valor) {
  const s = String(valor ?? '').trim()
  if (!s) return null
  const lower = s.toLowerCase()
  if (lower.endsWith('@g.us')) return lower
  if (lower.startsWith('lid:')) {
    const d = lower.slice(4).replace(/\D/g, '')
    return d ? `lid:${d}` : null
  }
  if (lower.endsWith('@lid')) {
    const d = lower.slice(0, -4).replace(/\D/g, '')
    return d ? `lid:${d}` : null
  }
  if (lower.includes('@broadcast') || lower.includes('@newsletter')) return null
  const digits = lower.replace(/@[^@]+$/, '').replace(/\D/g, '')
  return digits || null
}

/** Variantes equivalentes da identidade (±9º dígito no Brasil). Grupo/LID não variam. */
function variantesDeIdentidade(identidade) {
  const s = String(identidade || '')
  if (!s) return []
  if (s.endsWith('@g.us') || s.startsWith('lid:')) return [s]
  const variantes = possiblePhonesForWhatsappIdentity(s)
  return Array.from(new Set([s, ...(variantes || [])].filter(Boolean)))
}

/**
 * Conversas deste tenant que correspondem à identidade do chat removido.
 *
 * Isolamento: `company_id` obrigatório + instância. Conversas de OUTRA instância nunca entram.
 * Conversa sem instância (`whatsapp_instance_id IS NULL`, legado) só entra quando a empresa tem
 * uma única instância ativa — com duas ou mais não há como saber de qual número ela é.
 */
async function encontrarConversasPorIdentidade({ company_id, whatsapp_instance_id, telefone } = {}) {
  const cid = Number(company_id)
  const identidade = chaveIdentidadeDeChat(telefone)
  if (!Number.isFinite(cid) || cid <= 0 || !identidade) return []

  const instanceId = Number(whatsapp_instance_id)
  const temInstancia = Number.isFinite(instanceId) && instanceId > 0

  const candidatos = variantesDeIdentidade(identidade)
  const colunas = 'id, telefone, tipo, cliente_id, whatsapp_instance_id, status_atendimento, chat_lid, ultima_atividade'

  const encontradas = new Map()
  const { data: porTelefone } = await supabase
    .from('conversas')
    .select(colunas)
    .eq('company_id', cid)
    .in('telefone', candidatos)
  for (const row of porTelefone || []) encontradas.set(row.id, row)

  // Conversa espelhada por LID guarda o número real em `telefone` e o LID em `chat_lid`.
  if (identidade.startsWith('lid:')) {
    const lidDigits = identidade.slice(4)
    const { data: porLid } = await supabase
      .from('conversas')
      .select(colunas)
      .eq('company_id', cid)
      .eq('chat_lid', lidDigits)
    for (const row of porLid || []) encontradas.set(row.id, row)
  }

  const rows = Array.from(encontradas.values())
  if (!rows.length) return []

  let aceitaSemInstancia = !temInstancia
  if (temInstancia && rows.some((r) => r.whatsapp_instance_id == null)) {
    try {
      const { instances } = await listWhatsappInstances(cid)
      const ativas = (instances || []).filter((i) => i && i.ativo !== false)
      aceitaSemInstancia = ativas.length <= 1
    } catch (_) {
      aceitaSemInstancia = false
    }
  }

  return rows.filter((r) => {
    if (r.whatsapp_instance_id == null) return aceitaSemInstancia
    if (!temInstancia) return true
    return Number(r.whatsapp_instance_id) === instanceId
  })
}

// =====================================================================================
// Aplicação da exclusão remota
// =====================================================================================

/**
 * Aplica no ZapERP a exclusão de um chat feita no WhatsApp.
 *
 * NÃO chama o provedor (o chat já não existe lá) — por isso não há loop.
 * NÃO apaga o cadastro do cliente: contato, tags do contato, CRM e campanhas ficam intactos.
 * Conversa de grupo é ignorada (sair de grupo é outro fluxo; o DELETE /chats/:id também recusa).
 *
 * @returns {Promise<{aplicadas:number[], ignorado?:string}>}
 */
async function aplicarExclusaoRemotaDeChat({
  company_id,
  whatsapp_instance_id = null,
  telefone,
  io = null,
  origem = 'whatsapp',
} = {}) {
  const cid = Number(company_id)
  if (!Number.isFinite(cid) || cid <= 0) return { aplicadas: [], ignorado: 'company_invalida' }
  if (!syncEntradaHabilitado()) return { aplicadas: [], ignorado: 'sync_desligado' }

  const identidade = chaveIdentidadeDeChat(telefone)
  if (!identidade) return { aplicadas: [], ignorado: 'identidade_invalida' }
  if (identidade.endsWith('@g.us')) return { aplicadas: [], ignorado: 'grupo' }

  if (foiExclusaoLocalRecente({ company_id: cid, telefone: identidade })) {
    return { aplicadas: [], ignorado: 'eco_da_propria_exclusao' }
  }

  const conversas = await encontrarConversasPorIdentidade({
    company_id: cid,
    whatsapp_instance_id,
    telefone: identidade,
  })
  if (!conversas.length) return { aplicadas: [], ignorado: 'conversa_nao_encontrada' }

  const aplicadas = []
  for (const conv of conversas) {
    const tipo = String(conv.tipo || '').toLowerCase()
    if (tipo === 'grupo' || tipo === 'group' || String(conv.telefone || '').endsWith('@g.us')) continue

    const r = await apagarDependenciasEConversa({ company_id: cid, conversa_id: conv.id })
    if (!r.ok) {
      console.warn('[chatDeletionSync] falha ao apagar conversa vinda do WhatsApp', {
        company_id: cid,
        conversa_id: conv.id,
        error: r.error,
      })
      continue
    }
    aplicadas.push(conv.id)
    emitirConversaApagada(io, {
      company_id: cid,
      conversa_id: conv.id,
      cliente_id: conv.cliente_id ?? null,
      cliente_apagado: false,
      whatsapp_apagado: true,
      origem,
    })
    console.log('[chatDeletionSync] conversa apagada no WhatsApp → removida do ZapERP', {
      company_id: cid,
      conversa_id: conv.id,
      whatsapp_instance_id: conv.whatsapp_instance_id ?? null,
      origem,
    })
  }

  return { aplicadas }
}

/**
 * Lote de chats removidos num único webhook. Acima do teto nada é apagado (proteção contra
 * resync/backlog do canal apagar a base inteira).
 * @returns {Promise<{aplicadas:number[], ignorados:Record<string,number>, recusadoPorLote?:boolean}>}
 */
async function aplicarExclusaoRemotaEmLote({
  company_id,
  whatsapp_instance_id = null,
  chats = [],
  io = null,
  origem = 'whatsapp',
} = {}) {
  const lista = (Array.isArray(chats) ? chats : [])
    .map((c) => chaveIdentidadeDeChat(typeof c === 'string' ? c : (c?.id ?? c?.chat_id ?? c?.chatId)))
    .filter(Boolean)
  const unicos = Array.from(new Set(lista))
  const ignorados = {}
  if (!unicos.length) return { aplicadas: [], ignorados }

  const teto = tetoExclusoesPorLote()
  if (teto > 0 && unicos.length > teto) {
    console.warn('[chatDeletionSync] lote de exclusão RECUSADO (acima do teto)', {
      company_id: Number(company_id),
      whatsapp_instance_id,
      recebidos: unicos.length,
      teto,
      dica: 'Lote grande costuma ser resync do canal. Ajuste WHATSAPP_CHAT_DELETE_SYNC_MAX_BATCH ou use a reconciliação manual.',
    })
    return { aplicadas: [], ignorados: { lote_acima_do_teto: unicos.length }, recusadoPorLote: true }
  }

  const aplicadas = []
  for (const identidade of unicos) {
    const r = await aplicarExclusaoRemotaDeChat({
      company_id,
      whatsapp_instance_id,
      telefone: identidade,
      io,
      origem,
    })
    if (r.ignorado) ignorados[r.ignorado] = (ignorados[r.ignorado] || 0) + 1
    for (const id of r.aplicadas) aplicadas.push(id)
  }
  return { aplicadas, ignorados }
}

// =====================================================================================
// Reconciliação (fallback para quem não avisa pelo webhook — UltraMSG)
// =====================================================================================

const RECONCILIACAO_INATIVIDADE_HORAS_PADRAO = 24
const RECONCILIACAO_LIMITE_PADRAO = 50

/**
 * Compara a lista de chats do provedor com as conversas do ZapERP e aponta (ou aplica) as que
 * já não existem mais no WhatsApp. É o substituto possível para o provedor que não manda evento
 * de exclusão (UltraMSG) e também serve de rede para a Whapi quando o webhook de `chats` ficou
 * desligado durante uma janela.
 *
 * Conservadora de propósito:
 * - lista vazia do provedor ABORTA (não dá para distinguir "não tem chat" de "chamada falhou");
 * - nunca considera grupo, conversa por LID sem número, nem conversa sem telefone;
 * - nunca considera conversa `em_atendimento` (alguém está atendendo agora);
 * - exige inatividade mínima (`inatividadeHoras`, padrão 24h) — chat novo pode ainda não constar;
 * - `aplicar` é opt-in: por padrão só devolve os candidatos (simulação);
 * - respeita o `limite` por execução.
 *
 * @returns {Promise<{ok:boolean, error?:string, provider_chats:number, candidatos:Array, aplicadas:number[], simulacao:boolean}>}
 */
async function reconciliarExclusoesDeChats({
  company_id,
  whatsapp_instance_id,
  provider,
  aplicar = false,
  io = null,
  inatividadeHoras = RECONCILIACAO_INATIVIDADE_HORAS_PADRAO,
  limite = RECONCILIACAO_LIMITE_PADRAO,
} = {}) {
  const cid = Number(company_id)
  const instanceId = Number(whatsapp_instance_id)
  if (!Number.isFinite(cid) || cid <= 0) return { ok: false, error: 'company_id inválido', provider_chats: 0, candidatos: [], aplicadas: [], simulacao: !aplicar }
  if (!Number.isFinite(instanceId) || instanceId <= 0) return { ok: false, error: 'whatsapp_instance_id inválido', provider_chats: 0, candidatos: [], aplicadas: [], simulacao: !aplicar }
  if (typeof provider?.getChats !== 'function') {
    return { ok: false, error: 'Provedor não lista chats.', provider_chats: 0, candidatos: [], aplicadas: [], simulacao: !aplicar }
  }

  let chatsProvedor = []
  try {
    chatsProvedor = await provider.getChats({ companyId: cid, whatsappInstanceId: instanceId })
  } catch (e) {
    return { ok: false, error: `Falha ao listar chats no provedor: ${e?.message || e}`, provider_chats: 0, candidatos: [], aplicadas: [], simulacao: !aplicar }
  }
  const identidadesProvedor = new Set()
  for (const c of chatsProvedor || []) {
    const bruto = typeof c === 'string' ? c : (c?.id ?? c?.chatId ?? c?.chat_id ?? c?.jid)
    for (const v of variantesDeIdentidade(chaveIdentidadeDeChat(bruto) || '')) {
      if (v) identidadesProvedor.add(v)
    }
  }
  if (identidadesProvedor.size === 0) {
    return {
      ok: false,
      error: 'O provedor devolveu nenhum chat — abortado para não apagar conversas por falha de leitura.',
      provider_chats: 0,
      candidatos: [],
      aplicadas: [],
      simulacao: !aplicar,
    }
  }

  const horas = Number.isFinite(Number(inatividadeHoras)) && Number(inatividadeHoras) >= 0
    ? Number(inatividadeHoras)
    : RECONCILIACAO_INATIVIDADE_HORAS_PADRAO
  const corte = new Date(Date.now() - horas * 3600_000).toISOString()

  const { data: conversas, error: errSel } = await supabase
    .from('conversas')
    .select('id, telefone, tipo, cliente_id, status_atendimento, ultima_atividade, nome_contato_cache')
    .eq('company_id', cid)
    .eq('whatsapp_instance_id', instanceId)
    .limit(5000)
  if (errSel) {
    return { ok: false, error: errSel.message, provider_chats: identidadesProvedor.size, candidatos: [], aplicadas: [], simulacao: !aplicar }
  }

  const tetoAplicar = Number.isFinite(Number(limite)) && Number(limite) > 0
    ? Math.floor(Number(limite))
    : RECONCILIACAO_LIMITE_PADRAO

  const candidatos = []
  for (const conv of conversas || []) {
    const telefone = String(conv.telefone || '').trim()
    if (!telefone) continue
    const identidade = chaveIdentidadeDeChat(telefone)
    if (!identidade) continue
    if (identidade.endsWith('@g.us') || identidade.startsWith('lid:')) continue
    const tipo = String(conv.tipo || '').toLowerCase()
    if (tipo === 'grupo' || tipo === 'group') continue
    if (String(conv.status_atendimento || '').toLowerCase() === 'em_atendimento') continue
    if (conv.ultima_atividade && String(conv.ultima_atividade) > corte) continue
    if (variantesDeIdentidade(identidade).some((v) => identidadesProvedor.has(v))) continue
    candidatos.push({
      conversa_id: conv.id,
      telefone,
      cliente_id: conv.cliente_id ?? null,
      ultima_atividade: conv.ultima_atividade ?? null,
      status_atendimento: conv.status_atendimento ?? null,
    })
    if (candidatos.length >= tetoAplicar) break
  }

  if (!aplicar) {
    return { ok: true, provider_chats: identidadesProvedor.size, candidatos, aplicadas: [], simulacao: true }
  }

  const aplicadas = []
  for (const cand of candidatos) {
    const r = await apagarDependenciasEConversa({ company_id: cid, conversa_id: cand.conversa_id })
    if (!r.ok) {
      console.warn('[chatDeletionSync] reconciliação: falha ao apagar', { company_id: cid, conversa_id: cand.conversa_id, error: r.error })
      continue
    }
    aplicadas.push(cand.conversa_id)
    emitirConversaApagada(io, {
      company_id: cid,
      conversa_id: cand.conversa_id,
      cliente_id: cand.cliente_id,
      cliente_apagado: false,
      whatsapp_apagado: true,
      origem: 'reconciliacao',
    })
  }
  console.log('[chatDeletionSync] reconciliação aplicada', {
    company_id: cid,
    whatsapp_instance_id: instanceId,
    provider_chats: identidadesProvedor.size,
    candidatos: candidatos.length,
    aplicadas: aplicadas.length,
  })
  return { ok: true, provider_chats: identidadesProvedor.size, candidatos, aplicadas, simulacao: false }
}

module.exports = {
  chaveIdentidadeDeChat,
  variantesDeIdentidade,
  registrarExclusaoLocal,
  foiExclusaoLocalRecente,
  encontrarConversasPorIdentidade,
  aplicarExclusaoRemotaDeChat,
  aplicarExclusaoRemotaEmLote,
  reconciliarExclusoesDeChats,
  syncEntradaHabilitado,
  tetoExclusoesPorLote,
  RECONCILIACAO_INATIVIDADE_HORAS_PADRAO,
  RECONCILIACAO_LIMITE_PADRAO,
  _test: {
    resetEco: () => _ecoRecentes.clear(),
    ecoSize: () => _ecoRecentes.size,
  },
}
