/**
 * Triagem Interativa Whapi — Seam A (renderização do menu).
 * Monta o payload nativo (enquete / lista / botões) a partir das opções e envia
 * pelo adapter Whapi (getProvider({ provider:'whapi' })). NUNCA usado para UltraMSG.
 *
 * Enquete (poll) é o modo RECOMENDADO: botões/listas são instáveis no WhatsApp (aviso Whapi).
 * Em poll, as opções são texto (o voto volta como hash do texto → resolvido por label).
 * Em list/button, cada opção carrega o id UUID estável (a resposta volta com ele).
 */

// WhatsApp: no máximo 3 botões de resposta rápida; lista aceita bem mais (cap defensivo 10).
const MAX_BUTTONS = 3
const MAX_LIST_ROWS = 10
const MAX_POLL_OPTIONS = 12
const TITLE_MAX = 24 // título de botão/linha é curto no WhatsApp

function activeSorted(config) {
  return (config?.options || [])
    .filter((o) => o && o.active !== false && o.departamento_id != null && String(o.label || '').trim())
    .sort((a, b) => (a.ordem || 0) - (b.ordem || 0))
}

function clampTitle(label) {
  return String(label || '').trim().slice(0, TITLE_MAX) || 'Setor'
}

/** Payload de enquete p/ provider.sendPoll(phone, payload, opts). count 1 = escolha única. */
function buildPollPayload(config) {
  const opts = activeSorted(config)
  // Opções de enquete precisam ser distintas; se dois setores têm o mesmo label, desambigua.
  const seen = new Map()
  const options = []
  for (const o of opts.slice(0, MAX_POLL_OPTIONS)) {
    let label = String(o.label || '').trim() || 'Setor'
    if (seen.has(label)) {
      const n = seen.get(label) + 1
      seen.set(label, n)
      label = `${label} (${n})`
    } else {
      seen.set(label, 1)
    }
    options.push(label)
  }
  return { title: config.body_text, options, count: 1 }
}

/** Payload de mensagem interativa (list|button) p/ provider.sendInteractive(phone, payload, opts). */
function buildInteractivePayload(config) {
  const opts = activeSorted(config)
  const base = {
    body: config.body_text,
    ...(config.header_text ? { header: config.header_text } : {}),
    ...(config.footer_text ? { footer: config.footer_text } : {}),
  }
  if (config.mode === 'button') {
    return {
      ...base,
      type: 'button',
      action: {
        buttons: opts.slice(0, MAX_BUTTONS).map((o) => ({
          type: 'quick_reply',
          id: String(o.id), // provider_option_id estável
          title: clampTitle(o.label),
        })),
      },
    }
  }
  // list
  return {
    ...base,
    type: 'list',
    action: {
      label: config.button_label || 'Selecionar setor',
      list: {
        sections: [
          {
            title: config.button_label || 'Setores',
            rows: opts.slice(0, MAX_LIST_ROWS).map((o) => ({
              id: String(o.id), // provider_option_id estável
              title: clampTitle(o.label),
            })),
          },
        ],
      },
    },
  }
}

/** Metadados persistidos no ZapERP para o atendente enxergar o mesmo menu enviado. */
function buildTriageReplyMeta(config) {
  const mode = config?.mode || 'poll'
  if (mode === 'poll') {
    const poll = buildPollPayload(config)
    return {
      poll,
      whapi_triage: { mode, title: poll.title, options: poll.options, count: poll.count },
    }
  }
  const payload = buildInteractivePayload(config)
  const choices = mode === 'button'
    ? (payload.action?.buttons || []).map((b) => ({ id: String(b.id), title: b.title }))
    : (payload.action?.list?.sections || []).flatMap((s) => (s.rows || []).map((r) => ({ id: String(r.id), title: r.title })))
  return {
    whapi_triage: {
      mode,
      body: payload.body,
      header: payload.header || null,
      footer: payload.footer || null,
      button_label: mode === 'list' ? (payload.action?.label || null) : null,
      options: choices,
    },
  }
}

/**
 * Envia o menu de triagem interativa pela Whapi.
 * @param {object} args
 * @param {object} args.provider - getProvider({ provider:'whapi' })
 * @param {string} args.telefone
 * @param {object} args.config   - config ativa (whapiTriageConfigService)
 * @param {object} [args.opts]   - { companyId, whatsappInstanceId, ... } repassado ao adapter
 * @returns {Promise<{ ok:boolean, messageId:(string|null), mode:string, error?:string }>}
 */
async function sendWhapiTriageMenu({ provider, telefone, config, opts = {} }) {
  if (!provider || !telefone || !config) {
    return { ok: false, messageId: null, mode: config?.mode || 'poll', error: 'parâmetros ausentes' }
  }
  const mode = config.mode || 'poll'
  try {
    if (mode === 'poll') {
      if (typeof provider.sendPoll !== 'function') {
        return { ok: false, messageId: null, mode, error: 'provider sem sendPoll' }
      }
      const r = await provider.sendPoll(telefone, buildPollPayload(config), opts)
      return { ok: !!r?.ok, messageId: r?.messageId || null, mode, error: r?.error || null }
    }
    if (typeof provider.sendInteractive !== 'function') {
      return { ok: false, messageId: null, mode, error: 'provider sem sendInteractive' }
    }
    const r = await provider.sendInteractive(telefone, buildInteractivePayload(config), opts)
    return { ok: !!r?.ok, messageId: r?.messageId || null, mode, error: r?.error || null }
  } catch (e) {
    return { ok: false, messageId: null, mode, error: e?.message || String(e) }
  }
}

module.exports = {
  buildPollPayload,
  buildInteractivePayload,
  buildTriageReplyMeta,
  sendWhapiTriageMenu,
  activeSorted,
  MAX_BUTTONS,
  MAX_LIST_ROWS,
  MAX_POLL_OPTIONS,
}
