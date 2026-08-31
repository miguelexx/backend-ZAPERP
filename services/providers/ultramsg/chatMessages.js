const { CHATS_MESSAGES_LIMIT_MAX, OLD_MESSAGES_SYNC_MAX_PAGES } = require('./constants')
const { chatMessageCandidatesForLookup } = require('./phones')
const { resolveConfig } = require('./config')
const { getJson } = require('./http')

function oldMessagesDebugEnabled(opts = {}) {
  return opts?.debugOldMessages === true ||
    String(process.env.OLD_MESSAGES_SYNC_DEBUG || '').trim() === '1' ||
    String(process.env.WHATSAPP_DEBUG || '').trim() === '1'
}

function safeChatIdTail(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  return raw.length <= 14 ? raw : `...${raw.slice(-14)}`
}

function oldProviderMessageId(message) {
  const values = [
    message?.messageId,
    message?.zaapId,
    message?.id,
    message?.msgId,
    message?.message_id,
    message?.key?.id,
  ]
  for (const value of values) {
    if (value != null && String(value).trim()) return String(value).trim()
  }
  return ''
}

/**
 * Classifica uma resposta de /chats/messages.
 *
 * A UltraMSG responde HTTP 200 mesmo em erro (token inválido, instância desconectada),
 * devolvendo um objeto `{ error: ... }` no lugar do array de mensagens. Sem esta guarda,
 * esse corpo de erro era lido como "0 mensagens" e o usuário via
 * "Nenhuma mensagem antiga encontrada" em vez do erro real — um erro silencioso.
 *
 * @returns {{ ok: boolean, data: any[], error: string|null, bodyIsErrorObject: boolean }}
 */
function classifyChatMessagesPage(response) {
  const data = Array.isArray(response?.data) ? response.data : []
  const bodyIsErrorObject =
    response?.ok === true &&
    !Array.isArray(response?.data) &&
    !!response?.data &&
    typeof response.data === 'object' &&
    response.data.error != null &&
    response.data.error !== false &&
    String(response.data.error).toLowerCase() !== 'false'
  const ok = response?.ok === true && !bodyIsErrorObject
  const error = ok
    ? null
    : String(
        (bodyIsErrorObject ? response.data.error : null) ||
          response?.error ||
          response?.text ||
          response?.status ||
          'erro na consulta'
      ).slice(0, 180)
  return { ok, data, error, bodyIsErrorObject }
}

/**
 * Mensagens do chat. UltraMsg: GET /chats/messages (limit obrigatório, max 1000).
 *
 * IMPORTANTE (limitação da UltraMSG): este endpoint só devolve o que a UltraMSG tem
 * armazenado para a instância — mensagens que transitaram pela instância DESDE a conexão.
 * Não recupera o histórico anterior à conexão nem mensagens que existem apenas no celular.
 * Para um contato cujo histórico é todo pré-conexão, a resposta legítima é um array vazio.
 */
async function getChatMessages(phone, amount = 10, lastMessageId = null, opts = {}) {
  const cfg = await resolveConfig(opts)
  const returnDetails = opts?.returnDetails === true
  const endpoint = '/chats/messages'
  const limit = Math.min(CHATS_MESSAGES_LIMIT_MAX, Math.max(1, Number(amount) || 10))
  const debug = oldMessagesDebugEnabled(opts)
  const emptyDetails = (overrides = {}) => ({
    ok: false,
    data: [],
    endpoint,
    limit,
    attempts: [],
    ...overrides,
  })
  if (!cfg) {
    const result = emptyDetails({ error: 'Instancia UltraMsg nao configurada.' })
    return returnDetails ? result : []
  }
  const chatIds = chatMessageCandidatesForLookup(phone, opts)
  if (!chatIds.length) {
    const result = emptyDetails({ error: 'Nenhum chatId valido para consultar mensagens.' })
    return returnDetails ? result : []
  }

  const attempts = []
  let firstEmptyOk = null
  let lastError = null
  try {
    for (const chatId of chatIds) {
      const allData = []
      const seenIds = new Set()
      let cursor = lastMessageId ? String(lastMessageId).trim() : ''
      let chatOk = false
      const maxPages = opts?.fetchAllPages === true ? OLD_MESSAGES_SYNC_MAX_PAGES : 1

      for (let page = 0; page < maxPages; page += 1) {
        let response = null
        try {
          const extraParams = { chatId, limit: String(limit) }
          if (cursor) extraParams.lastMessageId = cursor
          response = await getJson({
            ...cfg,
            endpoint,
            extraParams,
          })
        } catch (e) {
          response = { ok: false, status: null, data: null, text: '', error: e?.message || String(e) }
        }

        const { ok: pageOk, data, error: pageError } = classifyChatMessagesPage(response)
        const idsInPage = data.map(oldProviderMessageId).filter(Boolean)
        let newInPage = 0
        for (const msg of data) {
          const msgId = oldProviderMessageId(msg)
          if (msgId) {
            if (seenIds.has(msgId)) continue
            seenIds.add(msgId)
          }
          allData.push(msg)
          newInPage += 1
        }

        const attempt = {
          chatIdTail: safeChatIdTail(chatId),
          page: page + 1,
          cursorTail: safeChatIdTail(cursor),
          ok: pageOk,
          status: response?.status ?? null,
          count: data.length,
          newCount: newInPage,
          error: pageOk ? null : pageError,
        }
        attempts.push(attempt)

        if (debug) {
          console.log('[oldMessagesSync][provider] getChatMessages', {
            companyId: opts?.companyId ?? opts?.company_id ?? null,
            endpoint,
            chatIdTail: attempt.chatIdTail,
            page: attempt.page,
            cursorTail: attempt.cursorTail,
            ok: attempt.ok,
            status: attempt.status,
            returned: attempt.count,
            newCount: attempt.newCount,
            error: attempt.error,
          })
        }

        if (!pageOk) {
          lastError = attempt.error || 'Erro ao buscar mensagens antigas.'
          break
        }

        chatOk = true
        if (data.length === 0) break
        if (opts?.fetchAllPages !== true) break
        if (data.length < limit) break
        if (page > 0 && newInPage === 0) break

        const nextCursor = idsInPage[idsInPage.length - 1] || ''
        if (!nextCursor || nextCursor === cursor) break
        cursor = nextCursor
      }

      if (chatOk && allData.length > 0) {
        const result = { ok: true, data: allData, chatId, endpoint, limit, attempts }
        return returnDetails ? result : allData
      }
      if (chatOk) {
        if (!firstEmptyOk) firstEmptyOk = { chatId, data: [] }
        continue
      }
    }

    if (firstEmptyOk) {
      const result = { ok: true, data: [], chatId: firstEmptyOk.chatId, endpoint, limit, attempts }
      return returnDetails ? result : []
    }

    const result = emptyDetails({
      error: lastError || 'Erro ao buscar mensagens antigas.',
      attempts,
    })
    return returnDetails ? result : []
  } catch (e) {
    const result = emptyDetails({
      error: e?.message || 'Erro ao buscar mensagens antigas.',
      attempts,
    })
    return returnDetails ? result : []
  }
}

module.exports = {
  classifyChatMessagesPage,
  getChatMessages,
}
