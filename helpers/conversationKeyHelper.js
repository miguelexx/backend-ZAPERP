/**
 * Chave canônica da conversa Z-API.
 * Centraliza resolvePeerPhone e resolveConversationKey para evitar duplicação
 * (especialmente quando fromMe=true e payload.phone = nosso número).
 */

const { normalizePhoneBR } = require('./phoneHelper')

const WHATSAPP_DEBUG = String(process.env.WHATSAPP_DEBUG || '').toLowerCase() === 'true'

/**
 * Extrai o número do CONTATO (peer) do payload — nunca o connectedPhone.
 * CRÍTICO para fromMe=true: a chave deve ser o DESTINO (quem recebeu), nunca quem enviou.
 *
 * @param {object} payload
 * @returns {{ peerPhone: string|null, source: string, fromMe: boolean, connectedPhone: string }}
 */
function resolvePeerPhone(payload) {
  const fromMe = Boolean(payload?.fromMe ?? payload?.key?.fromMe)
  const clean = (v) => (v == null ? '' : String(v).trim())
  const digits = (v) => clean(v).replace(/\D/g, '')

  const connectedPhone = digits(payload?.connectedPhone ?? payload?.ownerPhone ?? payload?.instancePhone ?? payload?.phoneNumber ?? payload?.me?.phone ?? '')
  const tail11 = (d) => d ? digits(d).slice(-11) : ''
  const isMyNumber = (d) => connectedPhone && d && tail11(d) === tail11(connectedPhone)

  const isLidJid = (v) => { const s = clean(v); return s.endsWith('@lid') || s.endsWith('@broadcast') }
  const isGrpJid = (v) => { const s = clean(v); return s.endsWith('@g.us') || s.includes('-group') }
  const extractDigits = (raw) => {
    if (!raw) return ''
    const s = clean(raw)
    if (!s || isLidJid(s) || isGrpJid(s)) return ''
    const d = s.includes('@') ? s.replace(/@[^@]+$/, '').replace(/\D/g, '') : digits(s)
    return (d && d.length >= 8) ? d : ''
  }
  const looksLikeBRPhone = (d) => {
    if (!d) return false
    if (d.startsWith('55') && (d.length === 12 || d.length === 13)) return true
    if (d.length === 10 || d.length === 11) return true
    return false
  }
  const norm = (raw, skipMy = true) => {
    const d = extractDigits(raw)
    if (!d) return ''
    if (!looksLikeBRPhone(d)) return ''
    if (skipMy && isMyNumber(d)) return ''
    return normalizePhoneBR(d) || d
  }
  // Último recurso: aceita número não-BR (10+ dígitos) quando só temos LID — útil para contatos internacionais
  const normAllowNonBR = (raw, skipMy = true) => {
    const d = extractDigits(raw)
    if (!d || d.length < 10) return ''
    if (skipMy && isMyNumber(d)) return ''
    return normalizePhoneBR(d) || d
  }

  if (fromMe) {
    // Prioridade: to / toPhone / recipientPhone / key.remoteJid (destino explícito)
    // Inclui fontes aninhadas (payload.data, payload.value encapsulados, payload.message) e referencedMessage
    const destPriority = [
      [payload?.to, 'to'],
      [payload?.toPhone, 'toPhone'],
      [payload?.recipientPhone, 'recipientPhone'],
      [payload?.recipient, 'recipient'],
      [payload?.destination, 'destination'],
      [payload?.key?.remoteJid, 'key.remoteJid'],
      [payload?.key?.participant, 'key.participant'],
      [payload?.remoteJid, 'remoteJid'],
      [payload?.chatId, 'chatId'],
      [payload?.chat?.id, 'chat.id'],
      [payload?.chat?.remoteJid, 'chat.remoteJid'],
      [payload?.data?.key?.remoteJid, 'data.key.remoteJid'],
      [payload?.data?.remoteJid, 'data.remoteJid'],
      [payload?.data?.chatId, 'data.chatId'],
      [payload?.data?.to, 'data.to'],
      [payload?.data?.toPhone, 'data.toPhone'],
      [payload?.data?.recipientPhone, 'data.recipientPhone'],
      [payload?.value?.to, 'value.to'],
      [payload?.value?.toPhone, 'value.toPhone'],
      [payload?.value?.recipientPhone, 'value.recipientPhone'],
      [payload?.value?.key?.remoteJid, 'value.key.remoteJid'],
      [payload?.value?.remoteJid, 'value.remoteJid'],
      [payload?.message?.key?.remoteJid, 'message.key.remoteJid'],
      [payload?.referencedMessage?.phone, 'referencedMessage.phone'],
      [payload?.reaction?.referencedMessage?.phone, 'reaction.referencedMessage.phone'],
    ]
    for (const [raw, source] of destPriority) {
      const n = norm(raw)
      if (n) {
        if (WHATSAPP_DEBUG) {
          console.log('[resolvePeerPhone] DEV:', { fromMe, connectedPhone: connectedPhone ? `...${connectedPhone.slice(-6)}` : null, phone: payload?.phone, to: payload?.to, peerPhone: n, source })
        }
        return { peerPhone: n, source: `fromMe dest ${source}`, fromMe, connectedPhone }
      }
    }

    // Fallback 1: payload.phone existe e != connectedPhone (nunca retornar connectedPhone como peer)
    const phoneRaw = payload?.phone
    if (phoneRaw) {
      const n = norm(phoneRaw)
      if (n) {
        if (WHATSAPP_DEBUG) {
          console.log('[resolvePeerPhone] DEV:', { fromMe, connectedPhone: connectedPhone ? `...${connectedPhone.slice(-6)}` : null, phone: payload?.phone, to: payload?.to, peerPhone: n, source: 'phone fallback' })
        }
        return { peerPhone: n, source: 'fromMe phone fallback', fromMe, connectedPhone }
      }
    }

    // Fallback 2: só existe chatLid (@lid) → tentar allowNonBR nas mesmas fontes antes de desistir
    const phoneStr = clean(payload?.phone ?? '')
    const lastResortSources = [
      payload?.to, payload?.toPhone, payload?.recipientPhone, payload?.recipient,
      payload?.destination, payload?.key?.remoteJid, payload?.key?.participant,
      payload?.remoteJid, payload?.chatId, payload?.chat?.id, payload?.chat?.remoteJid,
      payload?.data?.key?.remoteJid, payload?.data?.remoteJid, payload?.data?.to,
      payload?.data?.toPhone, payload?.data?.recipientPhone,
      payload?.value?.to, payload?.value?.toPhone, payload?.value?.recipientPhone,
      payload?.value?.key?.remoteJid, payload?.value?.remoteJid,
      payload?.message?.key?.remoteJid, payload?.referencedMessage?.phone
    ]
    for (const raw of lastResortSources) {
      const n = normAllowNonBR(raw)
      if (n) {
        if (WHATSAPP_DEBUG) {
          console.log('[resolvePeerPhone] DEV:', { fromMe, peerPhone: n?.slice(-6), source: 'fromMe lastResort allowNonBR' })
        }
        return { peerPhone: n, source: 'fromMe lastResort allowNonBR', fromMe, connectedPhone }
      }
    }

    if (phoneStr.endsWith('@lid')) {
      if (WHATSAPP_DEBUG) {
        console.log('[resolvePeerPhone] DEV:', { fromMe, connectedPhone: connectedPhone ? `...${connectedPhone.slice(-6)}` : null, phone: payload?.phone, to: payload?.to, peerPhone: null, source: 'lid only - no peer' })
      }
      return { peerPhone: null, source: 'fromMe lid only', fromMe, connectedPhone, keyType: 'lid' }
    }

    return { peerPhone: null, source: 'fromMe no dest', fromMe, connectedPhone }
  }

  const peer = norm(payload?.phone ?? payload?.senderPhone ?? payload?.key?.remoteJid ?? payload?.remoteJid ?? payload?.chatId ?? payload?.chat?.id)
  if (peer) {
    if (WHATSAPP_DEBUG) {
      console.log('[resolvePeerPhone] DEV:', { fromMe, phone: payload?.phone, connectedPhone: connectedPhone ? `...${connectedPhone.slice(-6)}` : null, peerPhone: peer, source: '!fromMe' })
    }
    return { peerPhone: peer, source: '!fromMe sender', fromMe, connectedPhone }
  }
  return { peerPhone: null, source: '!fromMe no peer', fromMe, connectedPhone }
}

/**
 * Resolve chave canônica da conversa.
 * @param {object} payload
 * @param {number} [company_id]
 * @returns {{ company_id: number|null, canonicalPhone: string, chatLid: string|null, keyType: 'phone'|'lid'|'group'|'', isGroup: boolean }}
 */
function resolveConversationKey(payload, company_id = null) {
  const result = {
    company_id: company_id ?? null,
    canonicalPhone: '',
    chatLid: null,
    keyType: '',
    isGroup: false,
  }

  if (!payload || typeof payload !== 'object') return result

  const isGroup = Boolean(
    payload.isGroup === true ||
    ['grupo', 'group'].includes(String(payload.tipo || payload.type || '').toLowerCase()) ||
    [payload.key?.remoteJid, payload.remoteJid, payload.phone].some(v => String(v || '').includes('@g.us'))
  )

  if (isGroup) {
    const groupId = [payload.key?.remoteJid, payload.remoteJid, payload.chatId, payload.phone, payload.groupId]
      .map(v => String(v || '').trim())
      .find(v => v.endsWith('@g.us') || (v.replace(/\D/g, '').startsWith('120') && v.replace(/\D/g, '').length >= 15))
    result.canonicalPhone = groupId ? groupId.replace(/@g.us$/, '') : ''
    result.keyType = 'group'
    result.isGroup = true
    return result
  }

  const { peerPhone } = resolvePeerPhone(payload)
  if (peerPhone) {
    result.canonicalPhone = peerPhone
    result.keyType = 'phone'
    return result
  }

  const lidRaw = String(payload?.phone ?? payload?.chatLid ?? '').trim()
  if (lidRaw.endsWith('@lid')) {
    const lidPart = lidRaw.replace(/@lid$/i, '').trim()
    if (lidPart) {
      result.canonicalPhone = `lid:${lidPart}`
      result.chatLid = lidPart
      result.keyType = 'lid'
      return result
    }
  }

  return result
}

module.exports = { resolvePeerPhone, resolveConversationKey }
