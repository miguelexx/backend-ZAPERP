/**
 * Triagem Interativa Whapi — orquestrador (Seam A + Seam B).
 *
 * Quando a instância é Whapi E o módulo está ligado, ESTE serviço assume a triagem da conversa
 * (o chatbot de texto/números é pulado para esse inbound). Reusa o miolo testado do chatbot:
 * transferToDepartment (claim atômico + distribuição), logBotAction e a dedup por bot_logs.
 * NÃO duplica a lógica de setor; NÃO roda para UltraMSG (o pipeline só chama com provider whapi).
 *
 * Seam B (resposta): resolve a opção escolhida por interactiveReplyId (id UUID estável),
 * depois por título, depois por voto de enquete (label) → transfere.
 * Seam A (menu): na 1ª mensagem do cliente, envia o menu nativo (enquete/lista/botões).
 *
 * Idempotência: bot_logs (menu_enviado / opcao_valida) + lock em memória por conversa.
 */

const supabase = require('../../config/supabase')
const {
  transferToDepartment,
  logBotAction,
  wasMenuSentForConversa,
  wasOptionSelectedForConversa,
} = require('../chatbotTriageService')
const { sendWhapiTriageMenu, buildPollPayload, activeSorted } = require('./whapiTriageRenderer')
const { isRealWhatsAppId } = require('../../helpers/whatsappMessageIdHelper')

const DEFAULT_CONFIRM = 'Perfeito! Seu atendimento foi direcionado para o setor {{departamento}}. Em instantes nossa equipe dará continuidade.'

/** Locks em memória por conversa (mesma estratégia do chatbotTriageService). */
const selectInFlight = new Set()
const menuInFlight = new Set()
const lastMenuSentAt = new Map()
const MENU_DEBOUNCE_MS = 15_000

function convKey(conversa_id) {
  const n = Number(conversa_id)
  return Number.isFinite(n) && n > 0 ? n : String(conversa_id || '')
}

/** Normaliza texto para comparação de label (case/acentos-insensível leve). */
function normLabel(v) {
  return String(v || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()
}

/**
 * Resolve a opção escolhida a partir do inbound normalizado (Seam B).
 * Prioridade: id estável (interactiveReplyId) → título → voto de enquete (label).
 * @returns {object|null} opção da config (id, label, departamento_id, tag_id) ou null
 */
function resolveSelectedOption(payload, config) {
  const options = (config?.options || []).filter((o) => o && o.departamento_id != null && o.active !== false)
  if (!options.length) return null

  // 1) id UUID estável (list/button) — casamento exato, independe do label
  const replyId = payload?.interactiveReplyId != null ? String(payload.interactiveReplyId).trim() : ''
  if (replyId) {
    const byId = options.find((o) => String(o.id) === replyId)
    if (byId) return byId
  }

  // 2) título da resposta interativa (fallback quando o id não bate)
  const replyTitle = payload?.interactiveReplyTitle != null ? String(payload.interactiveReplyTitle).trim() : ''
  if (replyTitle) {
    const t = normLabel(replyTitle)
    const byTitle = options.find((o) => normLabel(o.label) === t)
    if (byTitle) return byTitle
  }

  // 3) voto de enquete → labels resolvidas (poll). Casa contra os labels renderizados da enquete
  //    (que podem ter sufixo de desambiguação " (n)"), mantendo o alinhamento por ordem.
  const votes = Array.isArray(payload?.pollVoteOptions) ? payload.pollVoteOptions : []
  if (votes.length) {
    const sorted = activeSorted(config)
    const pollLabels = buildPollPayload(config).options // alinhado por ordem com `sorted`
    for (const vote of votes) {
      const v = normLabel(vote)
      let idx = pollLabels.findIndex((lbl) => normLabel(lbl) === v)
      if (idx < 0) idx = sorted.findIndex((o) => normLabel(o.label) === v)
      if (idx >= 0 && sorted[idx]) return sorted[idx]
    }
  }

  return null
}

/** Deriva status da linha outbound do bot a partir do resultado de envio. */
function outboundStatus(sendResult) {
  const ok = sendResult?.ok === true
  const messageId = sendResult?.messageId ? String(sendResult.messageId).trim() : null
  const traceable = !!messageId && isRealWhatsAppId(messageId)
  return {
    messageId,
    traceable,
    status: ok ? (traceable ? 'sent' : 'pending') : 'erro',
    status_mensagem: ok ? (traceable ? 'sent' : 'sending') : 'failed',
  }
}

/** Persiste a bolha outbound do bot (menu/confirmação) e emite realtime. */
async function insertBotBubble({ sb, company_id, conversa_id, whatsapp_instance_id, texto, sendResult, emitRealtime }) {
  const st = outboundStatus(sendResult)
  const row = {
    conversa_id,
    company_id,
    texto,
    direcao: 'out',
    status: st.status,
    status_mensagem: st.status_mensagem,
    ...(st.traceable ? { whatsapp_id: st.messageId } : {}),
    ...(whatsapp_instance_id ? { whatsapp_instance_id } : {}),
  }
  try {
    const { data, error } = await sb.from('mensagens').insert(row).select('*').single()
    if (error) {
      console.warn('[whapiTriage] falha ao gravar bolha outbound (WhatsApp pode ter recebido):', error.message)
      return null
    }
    if (data && typeof emitRealtime === 'function') {
      try { await emitRealtime(data) } catch (e) { console.warn('[whapiTriage] emitRealtime:', e?.message || e) }
    }
    return data
  } catch (e) {
    console.warn('[whapiTriage] insertBotBubble:', e?.message || e)
    return null
  }
}

/**
 * Handler principal. Chamado pelo pipeline SÓ quando provider==='whapi' e o módulo está ligado.
 * @returns {Promise<{ handled:boolean, departamento_id?:number, atendente_id?:number|null, status_atendimento?:string }>}
 */
async function handleWhapiTriageInbound(ctx) {
  const {
    company_id,
    conversa_id,
    telefone,
    whatsapp_instance_id,
    texto = '',
    payload = {},
    config,
    supabaseClient,
    sendMessage,
    emitRealtime = null,
  } = ctx

  if (!company_id || !conversa_id || !telefone || !sendMessage || !config) return { handled: false }
  if (String(telefone).startsWith('lid:')) return { handled: false }

  const sb = supabaseClient || supabase
  const lockCid = convKey(conversa_id)

  // Estado atual: atendente humano ou setor já definido → triagem encerrada.
  let conv = null
  try {
    const { data } = await sb
      .from('conversas')
      .select('atendente_id, departamento_id')
      .eq('id', conversa_id)
      .eq('company_id', company_id)
      .maybeSingle()
    conv = data || null
  } catch (e) {
    console.warn('[whapiTriage] erro ao ler estado da conversa:', e?.message || e)
    return { handled: false }
  }
  if (conv?.atendente_id != null) return { handled: false }
  if (conv?.departamento_id != null) return { handled: true, departamento_id: Number(conv.departamento_id) }

  const opts = {
    companyId: company_id,
    ...(whatsapp_instance_id ? { whatsappInstanceId: whatsapp_instance_id, whatsapp_instance_id } : {}),
  }

  // ---- Seam B: cliente escolheu uma opção? ----
  const option = resolveSelectedOption(payload, config)
  if (option) {
    if (selectInFlight.has(lockCid)) return { handled: true }
    selectInFlight.add(lockCid)
    try {
      // revalida estado fresco antes do claim (webhooks paralelos)
      const { data: fresh } = await sb
        .from('conversas')
        .select('departamento_id, atendente_id')
        .eq('id', conversa_id)
        .eq('company_id', company_id)
        .maybeSingle()
      if (fresh?.atendente_id != null) return { handled: true }
      if (fresh?.departamento_id != null) return { handled: true, departamento_id: Number(fresh.departamento_id) }
      if (await wasOptionSelectedForConversa(sb, company_id, conversa_id)) return { handled: true }

      const result = await transferToDepartment(sb, company_id, conversa_id, option.departamento_id, {
        transferMode: 'departamento',
        tipo_distribuicao: 'fila',
      })
      if (!result.ok && result.reason === 'already_assigned') {
        return { handled: true }
      }
      const depNome = result.departamento_nome || option.label || 'setor'

      await logBotAction(company_id, conversa_id, 'opcao_valida', {
        origem: 'whapi_triage',
        option_id: option.id,
        departamento_id: option.departamento_id,
        departamento_nome: depNome,
        transfer_ok: result.ok,
      })

      // tag opcional
      if (option.tag_id) {
        try {
          await sb.from('conversa_tags').insert({ conversa_id, tag_id: Number(option.tag_id), company_id })
        } catch (e) {
          if (String(e?.code || '') !== '23505') console.warn('[whapiTriage] applyTag:', e?.message || e)
        }
      }

      const confirmTpl = config.confirm_message || DEFAULT_CONFIRM
      const confirmMsg = confirmTpl.replace(/\{\{departamento\}\}/gi, depNome)
      let confSend = { ok: false, messageId: null }
      try {
        confSend = await sendMessage(telefone, confirmMsg, { sendOrigin: 'whapi_triage', skipProviderDelay: true })
      } catch (e) {
        console.warn('[whapiTriage] erro ao enviar confirmação:', e?.message || e)
      }
      await insertBotBubble({
        sb, company_id, conversa_id, whatsapp_instance_id, texto: confirmMsg, sendResult: confSend, emitRealtime,
      })

      return {
        handled: true,
        departamento_id: Number(option.departamento_id),
        atendente_id: result.atendente_id ?? null,
        status_atendimento: result.status_atendimento || 'aberta',
      }
    } finally {
      selectInFlight.delete(lockCid)
    }
  }

  // ---- Seam A: enviar o menu na primeira mensagem do cliente ----
  const alreadySent = await wasMenuSentForConversa(sb, company_id, conversa_id)
  if (alreadySent) {
    // Menu já foi enviado e o cliente mandou algo que não é opção → não reenvia (evita spam).
    // O atendimento humano segue normalmente; a conversa permanece na triagem até escolher.
    return { handled: true }
  }

  // debounce + lock anti-rajada
  const nowMs = Date.now()
  if (menuInFlight.has(lockCid)) return { handled: true }
  const lastMs = lastMenuSentAt.get(lockCid) || 0
  if (nowMs - lastMs < MENU_DEBOUNCE_MS) return { handled: true }
  menuInFlight.add(lockCid)
  lastMenuSentAt.set(lockCid, nowMs)
  try {
    const provider = require('../providers').getProvider({ provider: 'whapi' })
    const menuResult = await sendWhapiTriageMenu({ provider, telefone, config, opts })

    if (!menuResult.ok && config.fallback_to_text) {
      // Fallback: deixa o chatbot de texto assumir (não marca menu_enviado aqui).
      console.warn('[whapiTriage] menu interativo falhou; fallback para texto:', menuResult.error)
      return { handled: false, fallbackToText: true }
    }

    // grava a bolha do menu (o body_text vira o texto persistido) + realtime
    await insertBotBubble({
      sb, company_id, conversa_id, whatsapp_instance_id,
      texto: config.body_text,
      sendResult: { ok: menuResult.ok, messageId: menuResult.messageId },
      emitRealtime,
    })
    await logBotAction(company_id, conversa_id, 'menu_enviado', {
      origem: 'whapi_triage',
      mode: menuResult.mode,
      opcoes: (config.options || []).map((o) => o.id),
    })
    return { handled: true }
  } catch (e) {
    console.warn('[whapiTriage] erro ao enviar menu:', e?.message || e)
    return { handled: config.fallback_to_text ? false : true, fallbackToText: !!config.fallback_to_text }
  } finally {
    menuInFlight.delete(lockCid)
  }
}

module.exports = {
  handleWhapiTriageInbound,
  resolveSelectedOption,
  _internal: { normLabel, outboundStatus },
}
