/**
 * Endereço REAL de um contato no WhatsApp (`wa_id`) — que não é o número que se disca.
 *
 * O número com o 9º dígito é o que o cliente informa e o que o sistema guarda; o JID no WhatsApp
 * pode ser o de 12 dígitos (sem o 9), e quem decide é o WhatsApp, não o formato do telefone.
 * Ações endereçadas a chat já resolvem isso tentando os dois endereços (`runOnChatCandidates` em
 * services/providers/whapi/chatsAdmin.js), mas as ações de GRUPO mandam a lista de participantes
 * de uma vez: não há como "tentar o outro endereço" por participante. Então aqui o endereço é
 * resolvido ANTES, perguntando ao próprio WhatsApp.
 *
 * Medido no canal em 10/11/2026 (POST /contacts):
 *   {"input":"5534999911246","status":"valid","wa_id":"553499911246@s.whatsapp.net"}
 * Era por isso que "adicionar ao grupo" falhava: o worker mandava `5534999911246`, endereço que
 * não existe, e a Whapi devolvia o contato em `failed` — registrado como "política anti-spam".
 */

/** Só os dígitos, sem @s.whatsapp.net / @lid / @g.us. */
function somenteDigitos(valor) {
  return String(valor ?? '').replace(/@[^@]+$/, '').replace(/\D/g, '')
}

/**
 * @typedef {object} EnderecoWhatsapp
 * @property {string} original  número como veio (só dígitos)
 * @property {string} jid       endereço a usar na chamada (wa_id quando o WhatsApp informou)
 * @property {boolean} existe   false só quando o WhatsApp afirmou que o número não tem conta
 * @property {boolean} verificado false quando não deu para consultar (seguimos com o original)
 */

/**
 * Resolve o endereço de vários telefones de uma vez (uma chamada só).
 *
 * Nunca transforma falha de consulta em "não existe": sem resposta, devolve o número original
 * com `verificado: false` e a ação segue como antes — a consulta é uma melhoria, não um portão.
 *
 * @param {object} provider provider do WhatsApp (precisa de `checkPhones` para resolver)
 * @param {string[]|string} telefones
 * @param {object} opts { companyId, whatsappInstanceId }
 * @returns {Promise<EnderecoWhatsapp[]>} na mesma ordem dos telefones válidos recebidos
 */
async function resolverEnderecosWhatsapp(provider, telefones, opts = {}) {
  const lista = (Array.isArray(telefones) ? telefones : [telefones])
    .map(somenteDigitos)
    .filter(Boolean)
  const unicos = [...new Set(lista)]
  if (unicos.length === 0) return []

  const semVerificar = unicos.map((original) => ({ original, jid: original, existe: true, verificado: false }))
  if (typeof provider?.checkPhones !== 'function') return semVerificar

  let linhas
  try {
    linhas = await provider.checkPhones(unicos, opts)
  } catch (e) {
    console.warn('[enderecoWhatsapp] checkPhones falhou, seguindo com os números originais:', e?.message || e)
    return semVerificar
  }
  if (!Array.isArray(linhas) || linhas.length === 0) return semVerificar

  const porInput = new Map()
  for (const linha of linhas) {
    if (!linha || typeof linha !== 'object') continue
    const chave = somenteDigitos(linha.input)
    if (chave) porInput.set(chave, linha)
  }

  return unicos.map((original) => {
    const linha = porInput.get(original)
    if (!linha) return { original, jid: original, existe: true, verificado: false }
    if (linha.exists === false) return { original, jid: original, existe: false, verificado: true }
    const waId = somenteDigitos(linha.waId)
    return { original, jid: waId || original, existe: true, verificado: true }
  })
}

/** Atalho para um telefone só. */
async function resolverEnderecoWhatsapp(provider, telefone, opts = {}) {
  const [endereco] = await resolverEnderecosWhatsapp(provider, [telefone], opts)
  return endereco || { original: somenteDigitos(telefone), jid: somenteDigitos(telefone), existe: true, verificado: false }
}

module.exports = {
  somenteDigitos,
  resolverEnderecosWhatsapp,
  resolverEnderecoWhatsapp,
}
