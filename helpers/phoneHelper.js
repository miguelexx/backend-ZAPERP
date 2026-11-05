/**
 * Normalização de telefone para Brasil (Z-API / WhatsApp).
 * Regras: apenas dígitos; prefixo 55; 12–13 dígitos (55 + DDD + número).
 * Grupos: preservar JID com @g.us.
 */

/** DDDs em uso no Brasil (Anatel). Usado só para decidir se 11 dígitos podem ser BR. */
const DDDS_BR = new Set([
  '11', '12', '13', '14', '15', '16', '17', '18', '19',
  '21', '22', '24', '27', '28',
  '31', '32', '33', '34', '35', '37', '38',
  '41', '42', '43', '44', '45', '46', '47', '48', '49',
  '51', '53', '54', '55',
  '61', '62', '63', '64', '65', '66', '67', '68', '69',
  '71', '73', '74', '75', '77', '79',
  '81', '82', '83', '84', '85', '86', '87', '88', '89',
  '91', '92', '93', '94', '95', '96', '97', '98', '99',
])

/**
 * 11 dígitos que PODEM ser um celular brasileiro sem DDI: DDD válido + `9` + 8 dígitos.
 *
 * Desde a universalização do nono dígito, todo número brasileiro de 11 dígitos é
 * `DDD + 9 + 8`. Logo, 11 dígitos cujo terceiro dígito não é `9` (ou cujo DDD não existe)
 * NÃO é brasileiro — é número estrangeiro com DDI: `+33 780259005` (França),
 * `+1 415 2223333` (EUA), `+34 612345678` (Espanha), `+56 912345678` (Chile).
 *
 * @param {string} digits - somente dígitos
 * @returns {boolean}
 */
function podeSerCelularBrSemDdi(digits) {
  const d = String(digits || '')
  if (d.length !== 11) return false
  if (d.charAt(2) !== '9') return false
  return DDDS_BR.has(d.slice(0, 2))
}

/**
 * Forma LEGADA de um endereço internacional de 11 dígitos: o mesmo número com o `55`
 * que `normalizePhoneBR` colava na frente antes da correção do doc 38.
 *
 * Serve só para BUSCA: registros gravados antes da correção (ex.: conversa do contato
 * francês guardada como `5533780259005`) precisam continuar casando com a chave nova
 * (`33780259005`), senão o próximo inbound abriria uma segunda conversa e o histórico
 * pareceria ter sumido. Devolve `''` quando não se aplica.
 *
 * Não há risco de casar com outra pessoa: `'55' + X` só existe como número brasileiro
 * de verdade quando `X` é celular BR — e esse caso nem chega aqui.
 *
 * @param {string} digits - somente dígitos
 * @returns {string}
 */
function formaLegadaCom55(digits) {
  const d = String(digits || '')
  if (d.length !== 11 || d.startsWith('0')) return ''
  if (podeSerCelularBrSemDdi(d)) return ''
  return '55' + d
}

/**
 * Normaliza telefone para padrão Brasil (armazenamento/consulta).
 * - Grupos: retorna o JID intacto (ex: 120363...@g.us).
 * - Individual: só dígitos; se 10 dígitos (DDD+8) adiciona 55 → 12; se 11 (DDD+9+8) adiciona 55 → 13.
 *
 * @param {string} phone - Número ou JID (ex: 3499999999, 5534999999999, 123@g.us)
 * @returns {string}
 */
function normalizePhoneBR(phone) {
  const s = String(phone || '').trim()
  if (!s) return ''

  if (s.endsWith('@g.us')) return s

  const digits = s.replace(/\D/g, '')
  if (!digits) return ''

  // ✅ Grupo (WhatsApp): IDs geralmente começam com 120 e são longos (ex.: 1203630...).
  // Aceitar para não quebrar envio/roteamento quando o provider mandar só os dígitos.
  if (digits.startsWith('120') && digits.length >= 15 && digits.length <= 22) return digits

  // ✅ BR strict:
  // - já vem com DDI 55: 55 + DDD(2) + número (8/9) => 12/13
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) return digits
  // - às vezes vem só DDD+numero (10/11)
  //
  // 11 dígitos: colar `55` em QUALQUER coisa transformava número estrangeiro em endereço
  // inexistente — `+33 780259005` (França) virava `5533780259005`, a Whapi aceitava o envio
  // e nunca entregava (doc 38). Hoje só ganha o DDI o que pode ser celular BR
  // (DDD válido + nono dígito); o resto já é endereço internacional completo e volta intacto.
  // Nada deixa de ser aceito: os dois ramos devolvem número, como antes.
  // Tronco "0" (`034…`) segue o caminho antigo de propósito — a correção dele mora na
  // escrita (`normalizePhoneBRParaCadastro`, doc 39 §8).
  if (digits.length === 10) return '55' + digits
  if (digits.length === 11) {
    if (digits.startsWith('0') || podeSerCelularBrSemDdi(digits)) return '55' + digits
    return digits
  }

  // ✅ Tronco "0" antes do DDD — hábito de agenda de celular ("034 99826-5514",
  // "+55 (034) 99826-5514"). Sem isto o contato era importado/cadastrado com um número
  // que NENHUM caminho de leitura aceita: aparecia na busca mas estourava 500 ao abrir
  // ("Não foi possível localizar ou criar conversa"). Doc 39.
  //
  // SEGURANÇA: este bloco roda DEPOIS de todas as regras acima, ou seja, só vê entradas
  // que hoje já retornam ''. Nenhum número hoje aceito muda de resultado — inclusive o
  // "550…" de 13 dígitos, que a regra BR strict acima já devolve intacto (ver doc 39 §8).
  // Só converte quando o resultado cai EXATAMENTE num formato BR válido; caso ambíguo
  // (ex.: código de operadora "041…") continua recusado.
  let semTronco = digits.replace(/^0+/, '')
  // "55" + "0" + DDD (13/14 díg.): o tronco está DEPOIS do DDI. Só aqui, no ramo já
  // recusado — o "550…" de 13 dígitos que a regra BR strict aceita acima não passa por aqui.
  if (semTronco.startsWith('550') && (semTronco.length === 13 || semTronco.length === 14)) {
    semTronco = '55' + semTronco.slice(2).replace(/^0+/, '')
  }
  if (semTronco && semTronco !== digits) {
    if (semTronco.length === 10 || semTronco.length === 11) return comDdiSeForBrValido('55' + semTronco)
    if (semTronco.startsWith('55') && (semTronco.length === 12 || semTronco.length === 13)) {
      return comDdiSeForBrValido(semTronco)
    }
  }

  // Qualquer outra coisa (ex.: timestamps/IDs) NÃO é telefone BR
  return ''
}

/**
 * Guarda de formato para o ramo de RECUPERAÇÃO de tronco (e só para ele): devolve o número
 * apenas se ele for `55` + DDD começando em 1–9 + 8/9 dígitos. DDD brasileiro nunca começa
 * com 0, então isto impede que uma recuperação transforme lixo em "telefone válido".
 * Não é aplicado ao que a regra BR strict já aceitava — esse caminho fica intacto.
 */
function comDdiSeForBrValido(digits) {
  return /^55[1-9]\d{9,10}$/.test(digits) ? digits : ''
}

/**
 * Telefone vindo da AGENDA do celular / cadastro manual (caminho de ESCRITA).
 *
 * Igual a `normalizePhoneBR`, com um caso a mais: `55` + `0` + DDD, de 13 ou 14 dígitos
 * ("+55 (034) 9826-5514"). Esse formato de 13 dígitos é aceito intacto pela regra BR strict
 * (`55` + 11 dígitos) e vira um endereço inexistente no WhatsApp — o envio sai com ✓ e nunca
 * chega (família do doc 38). Aqui, no momento de GRAVAR, ele é corrigido.
 *
 * Por que uma função separada: `normalizePhoneBR` é usada em dezenas de pontos de LEITURA
 * (busca, dedup, roteamento de inbound). Mudar lá o que hoje é aceito faria registros antigos
 * gravados como `550…` deixarem de casar com a própria conversa. Esta variante só é usada
 * onde o número está entrando no sistema.
 *
 * @param {string} phone
 * @returns {string}
 */
function normalizePhoneBRParaCadastro(phone) {
  const s = String(phone || '').trim()
  if (!s || s.endsWith('@g.us')) return normalizePhoneBR(phone)

  const digits = s.replace(/\D/g, '')

  // "55" + "0" + DDD → o tronco está depois do DDI ("+55 (034) 9826-5514").
  if (digits.startsWith('550') && (digits.length === 13 || digits.length === 14)) {
    const recuperado = comDdiSeForBrValido('55' + digits.slice(2).replace(/^0+/, ''))
    if (recuperado) return recuperado
  }

  // "0" + DDD sem DDI ("(034) 9826-5514" → 11 dígitos). A regra BR strict de 10/11 dígitos
  // aceita isso intacto e produz "5503498265514" (DDD "03", inexistente); por isso a correção
  // mora aqui, no caminho de escrita, e não na leitura.
  if (digits.startsWith('0')) {
    const recuperado = comDdiSeForBrValido('55' + digits.replace(/^0+/, ''))
    if (recuperado) return recuperado
  }

  return normalizePhoneBR(phone)
}

/**
 * Correção de tronco "0" para quem já tem seu próprio fluxo de normalização.
 *
 * Devolve número SOMENTE quando `normalizePhoneBR` (o que o fluxo normal usa) **não** chega
 * sozinho ao resultado certo — isto é, nas formas que a regra BR strict aceita intactas e
 * transforma em DDD inexistente: `0` + DDD (11 díg.) e `55` + `0` + DDD (13 díg.).
 * Em todo o resto devolve `''`.
 *
 * Uso: `const telefone = corrigirTroncoZeroBR(entrada) || entrada`. Como só devolve algo no
 * caso que hoje grava número errado, fica provado que nada muda para quem já entra certo.
 *
 * @param {string} phone
 * @returns {string} número BR canônico corrigido, ou '' se o fluxo normal já resolve
 */
function corrigirTroncoZeroBR(phone) {
  const paraCadastro = normalizePhoneBRParaCadastro(phone)
  if (!paraCadastro) return ''
  return paraCadastro !== normalizePhoneBR(phone) ? paraCadastro : ''
}

/**
 * Retorna variações prováveis do mesmo número BR para BUSCA/DEDUP:
 * - 55DD9XXXXXXXX (13) ↔ 55DDXXXXXXXX (12)
 * Útil quando a base tem registros com/sem o dígito 9 após o DDD.
 *
 * ATENÇÃO: isto é para "match" e deduplicação heurística, não para envio.
 *
 * @param {string} phone
 * @returns {string[]} lista única (somente dígitos ou JID de grupo)
 */
function possiblePhonesBR(phone) {
  const s = String(phone || '').trim()
  if (!s) return []
  if (s.endsWith('@g.us')) return [s]

  // Chave sintética LID (espelhamento sem número real): NÃO gerar variantes de telefone.
  // Retorna array vazio para não criar buscas/inserts com chave inválida na tabela clientes.
  if (s.startsWith('lid:')) return []

  const norm = normalizePhoneBR(s)
  const digits = String(norm || '').replace(/\D/g, '')
  if (!digits) return []

  const list = [digits]
  if (digits.startsWith('55')) {
    // 55 + DDD(2) + 9 + 8 = 13  → versão sem o 9 vira 12
    if (digits.length === 13 && digits.slice(4, 5) === '9') {
      list.push(digits.slice(0, 4) + digits.slice(5))
    }
    // 55 + DDD(2) + 8 = 12 → versão com 9 vira 13
    if (digits.length === 12) {
      list.push(digits.slice(0, 4) + '9' + digits.slice(4))
    }
  }
  // Endereço internacional: inclui a forma legada com `55` para continuar achando o que
  // foi gravado antes da correção do doc 38 (sem isto o histórico pareceria ter sumido).
  const legada = formaLegadaCom55(digits)
  if (legada) list.push(legada)
  return Array.from(new Set(list.filter(Boolean)))
}

/**
 * Chave de deduplicação BR:
 * - Se vier 13 dígitos no padrão 55DD9XXXXXXXX, remove o "9" após o DDD.
 * - Caso contrário, retorna os dígitos como estão.
 *
 * @param {string} phone
 * @returns {string}
 */
function phoneKeyBR(phone) {
  const s = String(phone || '').trim()
  if (!s) return ''
  if (s.endsWith('@g.us')) return s
  const norm = normalizePhoneBR(s)
  const digits = String(norm || '').replace(/\D/g, '')
  // Fallback internacional: quando não normaliza em BR, usa os dígitos puros.
  // Assim evitamos chave vazia (que colapsa múltiplos contatos em um só).
  if (!digits) {
    const anyDigits = s.replace(/\D/g, '')
    if (anyDigits.length >= 10 && anyDigits.length <= 15) return anyDigits
    return ''
  }
  if (digits.startsWith('55') && digits.length === 13 && digits.slice(4, 5) === '9') {
    return digits.slice(0, 4) + digits.slice(5)
  }
  return digits
}

/**
 * Normaliza identificador de GRUPO vindo do WhatsApp/Z-API para armazenamento.
 * Alguns providers usam:
 * - "120363...@g.us"
 * - "120363...-group"
 *
 * Em bancos antigos, `conversas.telefone` pode ser varchar(20). Para não quebrar,
 * retornamos apenas dígitos (geralmente 18–19), suficiente para chave estável do grupo.
 *
 * @param {string} groupId
 * @returns {string}
 */
function normalizeGroupIdForStorage(groupId) {
  const s = String(groupId || '').trim()
  if (!s) return ''
  const digits = s.replace(/\D/g, '')
  return digits || s
}

/**
 * Formato para ENVIO via Z-API: WhatsApp Brasil exige 13 dígitos para celular (55 + DDD + 9 + 8 dígitos).
 * Se o número tiver 12 dígitos (55 + DDD + 8), insere o "9" após o DDD para tentar envio ao celular.
 * Evita erro 400 da Z-API por número em formato antigo.
 *
 * @param {string} phone - Número já normalizado (ex: 553484079198)
 * @returns {string}
 */
function toZapiSendFormat(phone) {
  const s = String(phone || '').trim()
  if (s.endsWith('@g.us')) return s

  const digits = s.replace(/\D/g, '')
  if (!digits) return ''
  // grupo numérico (120...): enviar como está
  if (digits.startsWith('120') && digits.length >= 15 && digits.length <= 22) return digits
  if (digits.length === 10) return '55' + digits
  // Mesma regra do normalizePhoneBR (doc 38): só vira BR o que pode ser celular BR.
  // Endereço internacional de 11 dígitos sai como está — é o destino correto para o envio.
  if (digits.length === 11) {
    if (digits.startsWith('0') || podeSerCelularBrSemDdi(digits)) return '55' + digits
    return digits
  }
  if (!digits.startsWith('55') || digits.length < 12) return ''

  if (digits.length === 13) return digits
  if (digits.length === 12) {
    const ddd = digits.slice(2, 4)
    const rest = digits.slice(4)
    return '55' + ddd + '9' + rest
  }
  return ''
}

/**
 * Escolhe o MELHOR número BR para ENVIO, ciente de celular vs fixo.
 *
 * Motivação: `toZapiSendFormat` insere o nono dígito em QUALQUER número de 12
 * dígitos, o que está certo para celular mas erra o fixo (fixo não tem nono
 * dígito). Já mandar o celular guardado sem o 9 (55+DDD+8) cai em "número não
 * existe" no WhatsApp. Aqui decidimos pelo 1º dígito do número local (8 díg):
 *   - 6,7,8,9 → celular → insere o 9 → 13 dígitos
 *   - 2,3,4,5 → fixo    → mantém 12 dígitos (sem 9)
 * Números já com 13 dígitos ou não-BR passam sem alteração.
 *
 * Retorna somente dígitos (sem "+"), ou '' quando não se aplica (grupo/LID/inválido),
 * deixando o chamador cair no fluxo padrão.
 *
 * @param {string} phone
 * @returns {string}
 */
function preferredBrSendDigits(phone) {
  const s = String(phone || '').trim()
  if (!s || s.endsWith('@g.us') || s.includes('-group') || isLidPhoneKey(s)) return ''
  const rawDigits = s.replace(/\D/g, '')
  if (!rawDigits || rawDigits.startsWith('120')) return ''
  const norm = String(normalizePhoneBR(s) || '').replace(/\D/g, '')
  if (!norm.startsWith('55')) return ''
  if (norm.length === 13) return norm // já completo (55+DDD+9+8)
  if (norm.length === 12) {
    const localFirst = norm.charAt(4) // 1º dígito do número local de 8 dígitos
    if ('6789'.includes(localFirst)) return norm.slice(0, 4) + '9' + norm.slice(4) // celular
    return norm // fixo: mantém 12 dígitos
  }
  return ''
}

/**
 * Primeiro dígito do número local BR (após 55+DDD), para distinguir celular (6–9) de fixo (2–5).
 */
function brLocalFirstDigit(digits) {
  const d = String(digits || '').replace(/\D/g, '')
  if (!d.startsWith('55')) return ''
  if (d.length === 13 && d.charAt(4) === '9') return d.charAt(5)
  if (d.length === 12) return d.charAt(4)
  return ''
}

function isLikelyBrMobileDigits(digits) {
  const d = String(digits || '').replace(/\D/g, '')
  if (!d.startsWith('55')) return false
  if (d.length === 13 && d.charAt(4) === '9') return '6789'.includes(d.charAt(5))
  if (d.length === 12) return '6789'.includes(d.charAt(4))
  return false
}

/**
 * Variantes do mesmo JID WhatsApp para foto/metadados.
 * Celular: 12↔13 (com/sem 9) quando o local começa com 6–9.
 * Fixo: NÃO inventa o 9 — 5534 3xxxxxxx e 5534 93xxxxxxx são pessoas diferentes
 * (possiblePhonesBR misturava os dois e gravava a foto no contato errado).
 */
function possiblePhonesForWhatsappIdentity(phone) {
  const s = String(phone || '').trim()
  if (!s) return []
  if (s.endsWith('@g.us')) return [s]
  if (s.startsWith('lid:')) return []

  const norm = normalizePhoneBR(s)
  const digits = String(norm || '').replace(/\D/g, '') || String(s).replace(/\D/g, '')
  if (!digits || digits.startsWith('120')) return digits && !digits.startsWith('120') ? [digits] : []

  const list = [digits]
  if (!digits.startsWith('55')) {
    // Mesma razão de possiblePhonesBR: achar o registro gravado com o `55` indevido (doc 38).
    const legada = formaLegadaCom55(digits)
    if (legada) list.push(legada)
    return Array.from(new Set(list.filter(Boolean)))
  }

  if (digits.length === 13 && digits.charAt(4) === '9') {
    const without9 = digits.slice(0, 4) + digits.slice(5)
    if (isLikelyBrMobileDigits(without9) || isLikelyBrMobileDigits(digits)) {
      if ('6789'.includes(without9.charAt(4))) list.push(without9)
    }
  }
  if (digits.length === 12 && isLikelyBrMobileDigits(digits)) {
    list.push(digits.slice(0, 4) + '9' + digits.slice(4))
  }
  return Array.from(new Set(list.filter(Boolean)))
}

/**
 * Chave estável da identidade WhatsApp (foto/perfil).
 * Celular com/sem 9 casa; fixo NÃO casa com um celular que só difere pelo 9 após o DDD.
 */
function whatsappIdentityKey(phone) {
  const s = String(phone || '').trim()
  if (!s || s.startsWith('lid:')) return ''
  if (s.endsWith('@g.us')) return s
  const digits = String(normalizePhoneBR(s) || '').replace(/\D/g, '') || String(s).replace(/\D/g, '')
  if (!digits) return ''
  if (digits.startsWith('55') && digits.length === 13 && digits.charAt(4) === '9') {
    const without9 = digits.slice(0, 4) + digits.slice(5)
    if ('6789'.includes(without9.charAt(4))) return without9
    return digits
  }
  return digits
}

function isSameWhatsappIdentity(a, b) {
  const ka = whatsappIdentityKey(a)
  const kb = whatsappIdentityKey(b)
  if (ka && kb && ka === kb) return true
  const da = String(a || '').replace(/\D/g, '')
  const db = String(b || '').replace(/\D/g, '')
  return Boolean(da && db && da === db)
}

/**
 * Verifica se o chatId é de um grupo WhatsApp (@g.us ou ID 120...).
 *
 * @param {string} chatId - JID ou identificador (ex: 5511999999999@c.us, 120363...@g.us)
 * @returns {boolean}
 */
function isGroupChat(chatId) {
  const s = String(chatId || '').trim()
  if (!s) return false
  if (s.endsWith('@g.us')) return true
  const digits = s.replace(/\D/g, '')
  return digits.startsWith('120') && digits.length >= 15
}

/**
 * Verifica se o chatId é de contato individual (não grupo).
 *
 * @param {string} chatId
 * @returns {boolean}
 */
function isIndividualChat(chatId) {
  if (!chatId) return false
  return !isGroupChat(chatId) && (String(chatId).includes('@') || String(chatId).replace(/\D/g, '').length >= 10)
}

/**
 * Extrai o telefone (apenas dígitos) do chatId.
 * Ex: "5511999999999@c.us" → "5511999999999"
 *
 * @param {string} chatId
 * @returns {string}
 */
function extractPhoneFromChatId(chatId) {
  const s = String(chatId || '').trim()
  if (!s || s.endsWith('@g.us')) return ''
  const match = s.match(/^(\d+)@c\.us$/i)
  if (match) return match[1]
  const phone = s.replace(/@[^@]+$/, '').replace(/\D/g, '').trim()
  return phone || ''
}

/**
 * Chave sintética LID (espelhamento WhatsApp sem número real).
 * Nunca deve ser exibida como telefone nem enviada ao UltraMSG como chatId.
 */
function isLidPhoneKey(phone) {
  const s = String(phone || '').trim().toLowerCase()
  if (!s) return false
  return s.startsWith('lid:') || s.endsWith('@lid')
}

/**
 * Primeiro telefone real entre candidatos (ignora vazio, LID, broadcast).
 * Usado em UI (telefone_exibivel) e sync-old.
 * Só aceita números que passam em normalizePhoneBR (evita IDs LID numéricos longos).
 *
 * @param {...unknown} values
 * @returns {string|null}
 */
function pickRealPhoneCandidate(...values) {
  for (const value of values) {
    const raw = String(value || '').trim()
    if (!raw || isLidPhoneKey(raw)) continue
    const lower = raw.toLowerCase()
    if (lower.includes('@broadcast') || lower.includes('@newsletter')) continue
    if (lower.endsWith('@g.us')) continue
    if (lower.endsWith('@c.us')) {
      const fromChat = extractPhoneFromChatId(raw)
      if (normalizePhoneBR(fromChat)) return raw
      continue
    }
    if (normalizePhoneBR(raw)) return raw
  }
  return null
}

module.exports = {
  normalizePhoneBR,
  normalizePhoneBRParaCadastro,
  corrigirTroncoZeroBR,
  podeSerCelularBrSemDdi,
  formaLegadaCom55,
  toZapiSendFormat,
  preferredBrSendDigits,
  possiblePhonesBR,
  possiblePhonesForWhatsappIdentity,
  whatsappIdentityKey,
  isSameWhatsappIdentity,
  isLikelyBrMobileDigits,
  brLocalFirstDigit,
  phoneKeyBR,
  normalizeGroupIdForStorage,
  isGroupChat,
  isIndividualChat,
  extractPhoneFromChatId,
  isLidPhoneKey,
  pickRealPhoneCandidate,
}
