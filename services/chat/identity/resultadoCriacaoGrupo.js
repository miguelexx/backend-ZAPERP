/**
 * Quem NÃO entrou no grupo recém-criado.
 *
 * `POST /groups` da Whapi responde 200 mesmo quando o WhatsApp recusa parte dos participantes
 * (privacidade "quem pode me adicionar a grupos", anti-spam, endereço errado). Sem olhar a
 * resposta, a tela dizia "N participantes adicionados" e a pessoa não estava lá.
 *
 * A resposta pode trazer `failed[]` (lista explícita) e/ou `participants[]` (quem está no grupo).
 * Regras defensivas — preferimos não acusar a acusar errado:
 *   1. `failed[]` explícito manda.
 *   2. Sem `failed`, deduz pela ausência em `participants[]`, MAS só se nenhum participante vier
 *      como `@lid`: com LID não há como casar dígitos e todo mundo pareceria "fora".
 *   3. Sem nenhum dos dois, não afirma nada (lista vazia).
 *
 * O casamento é por TODAS as formas do número (com e sem 9º dígito): a Whapi ecoa o wa_id,
 * que pode não ser o número discado (ver enderecoWhatsappService).
 */

const { somenteDigitos } = require('./enderecoWhatsappService')

function formasDoAlvo(alvo) {
  const set = new Set()
  const add = (v) => { const d = somenteDigitos(v); if (d) set.add(d) }
  add(alvo?.original)
  add(alvo?.jid)
  add(alvo?.chatId)
  for (const c of Array.isArray(alvo?.candidatos) ? alvo.candidatos : []) add(c)
  try {
    const { possiblePhonesForWhatsappIdentity } = require('../../../helpers/phoneHelper')
    for (const v of [...set]) {
      const alt = possiblePhonesForWhatsappIdentity(v)
      if (Array.isArray(alt)) alt.forEach(add)
    }
  } catch { /* sem variantes extras */ }
  return set
}

function idDoParticipante(p) {
  if (p == null) return ''
  if (typeof p === 'string' || typeof p === 'number') return String(p)
  return String(p.id || p.chat_id || p.jid || p.phone || '')
}

/**
 * @param {object} data resposta da Whapi ao criar o grupo
 * @param {Array<{original:string,jid?:string,chatId?:string,candidatos?:string[]}>} alvos enviados
 * @returns {string[]} números originais (como o usuário escolheu) que não entraram
 */
function participantesNaoAdicionados(data, alvos) {
  const lista = Array.isArray(alvos) ? alvos : []
  if (!lista.length || !data || typeof data !== 'object') return []

  const casa = (ids) => {
    const digitos = new Set(ids.map((i) => somenteDigitos(idDoParticipante(i))).filter(Boolean))
    return (alvo) => [...formasDoAlvo(alvo)].some((d) => digitos.has(d))
  }

  if (Array.isArray(data.failed)) {
    if (!data.failed.length) return []
    const falhou = casa(data.failed)
    return lista.filter(falhou).map((a) => a.original)
  }

  if (Array.isArray(data.participants) && data.participants.length) {
    const ids = data.participants.map(idDoParticipante)
    if (ids.some((id) => id.toLowerCase().includes('@lid'))) return []
    const entrou = casa(ids)
    return lista.filter((a) => !entrou(a)).map((a) => a.original)
  }

  return []
}

module.exports = { participantesNaoAdicionados }
