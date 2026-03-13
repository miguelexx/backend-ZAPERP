/**
 * Contact enrichment: escolha segura de nome para evitar regressões.
 * Garante que nunca substituímos um nome "bom" por um "pior" ou não confiável.
 *
 * IMPORTANTE - Fontes permitidas para atualizar clientes.nome:
 * - syncUltramsg: GET /contacts UltraMsg (nome salvo no celular) — MAIOR prioridade
 * - senderName/chatName: webhook ReceivedCallback (perfil WhatsApp)
 * - Fallback: telefone quando nome ausente (evita contato vazio)
 *
 * RESTRIÇÃO: IA (aiDashboardService, chatbot, OpenAI) NÃO tem permissão para
 * atualizar nomes de contatos. Apenas sincronização UltraMsg e webhook podem.
 *
 * Fontes de nome (score):
 * - syncUltramsg: 110 (nome do contato no celular via GET /contacts — prioridade máxima)
 * - name: 110 (payload.name = nome completo salvo no celular — mesmo nível que syncUltramsg)
 * - chatName: 80
 * - nome_existente: 70 (já salvo, não sobrescrever com pior)
 * - senderName: 60 (notify/display do WhatsApp — não sobrescreve nome existente)
 * - pushname: 60
 */

const WHATSAPP_DEBUG = String(process.env.WHATSAPP_DEBUG || '').toLowerCase() === 'true'

/** Score por fonte (maior = mais confiável). Nome do celular (syncUltramsg/name) > perfil WhatsApp (senderName). */
const SOURCE_SCORE = {
  syncUltramsg: 110,
  name: 110,
  senderName: 60,
  chatName: 80,
  pushname: 60,
  nome_existente: 70,
  unknown: 0
}

/**
 * Normaliza nome: trim, colapsar espaços, remover caracteres estranhos.
 * @param {string|null|undefined} name
 * @returns {string|null}
 */
function normalizeName(name) {
  if (name == null || typeof name !== 'string') return null
  const s = String(name).trim().replace(/\s+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '')
  return s || null
}

/**
 * Verifica se o nome é "ruim" (não deve ser usado para atualizar contato).
 * @param {string|null|undefined} name
 * @returns {boolean}
 */
function isBadName(name) {
  const n = normalizeName(name)
  if (!n || n.length <= 2) return true

  const lower = n.toLowerCase()
  const badExact = ['unknown', 'null', 'undefined', 'contato', '(contato)', 'sem conversa']
  if (badExact.some(b => lower === b || lower === b.trim())) return true

  // Parece telefone: só dígitos ou começa com 55 + dígitos
  const digits = n.replace(/\D/g, '')
  if (digits.length >= 10 && (digits.startsWith('55') || /^\d{10,15}$/.test(digits))) return true

  // Só emojis ou caracteres especiais (menos de 2 letras)
  const letters = n.replace(/[\s\d\p{P}\p{S}]/gu, '').length
  if (letters < 2) return true

  return false
}

/**
 * Retorna o score de um nome baseado na fonte.
 * @param {string} source - senderName, chatName, pushname, syncUltramsg, nome_existente, unknown
 * @returns {number}
 */
function scoreName(name, source) {
  if (isBadName(name)) return 0
  return SOURCE_SCORE[source] ?? SOURCE_SCORE.unknown
}

/**
 * Escolhe o melhor nome entre o atual e o candidato.
 * Nunca substitui um nome bom por um pior.
 *
 * @param {string|null} currentName - Nome atualmente salvo
 * @param {string|null} candidateName - Nome candidato vindo do payload/sync
 * @param {string} source - Fonte do candidato: senderName, chatName, pushname, syncUltramsg, name, unknown
 * @param {object} [opts]
 * @param {boolean} [opts.fromMe] - Se a mensagem foi enviada por nós (candidato pode ser menos confiável)
 * @param {number} [opts.company_id] - Para log (opcional)
 * @param {string} [opts.telefoneTail] - Últimos 6 dígitos do telefone para log (opcional)
 * @returns {{ name: string|null, decision: 'kept'|'updated'|'unchanged' }}
 */
function chooseBestName(currentName, candidateName, source, opts = {}) {
  const { fromMe = false, company_id, telefoneTail } = opts
  const curr = normalizeName(currentName)
  const cand = normalizeName(candidateName)

  // Candidato ruim → mantém atual
  if (isBadName(cand)) {
    if (curr && cand && WHATSAPP_DEBUG) {
      console.log('[NAME_UPDATE]', {
        company_id: company_id ?? null,
        telefoneTail: telefoneTail ?? null,
        currentName: (curr || '').slice(0, 30),
        candidateName: (cand || '').slice(0, 30),
        source,
        decision: 'kept'
      })
    }
    return { name: curr || null, decision: 'kept' }
  }

  // Atual vazio ou ruim → usa candidato se for bom
  if (!curr || isBadName(curr)) {
    if (WHATSAPP_DEBUG) {
      console.log('[NAME_UPDATE]', {
        company_id: company_id ?? null,
        telefoneTail: telefoneTail ?? null,
        currentName: (curr || '').slice(0, 30),
        candidateName: (cand || '').slice(0, 30),
        source,
        decision: 'updated'
      })
    }
    return { name: cand, decision: 'updated' }
  }

  // fromMe: aceita syncUltramsg, name (nome completo do celular) e senderName; rejeita chatName/pushname (menos confiáveis)
  if (fromMe) {
    if (source !== 'senderName' && source !== 'syncUltramsg' && source !== 'name') {
      if (WHATSAPP_DEBUG) {
        console.log('[NAME_UPDATE]', {
          company_id: company_id ?? null,
          telefoneTail: telefoneTail ?? null,
          currentName: (curr || '').slice(0, 30),
          candidateName: (cand || '').slice(0, 30),
          source,
          decision: 'kept'
        })
      }
      return { name: curr, decision: 'kept' }
    }
  }

  // Candidato tem score menor que atual → não troca
  const scoreCand = scoreName(cand, source)
  const scoreCurr = curr ? SOURCE_SCORE.nome_existente : 0
  if (scoreCand <= scoreCurr) {
    if (WHATSAPP_DEBUG) {
      console.log('[NAME_UPDATE]', {
        company_id: company_id ?? null,
        telefoneTail: telefoneTail ?? null,
        currentName: (curr || '').slice(0, 30),
        candidateName: (cand || '').slice(0, 30),
        source,
        decision: 'kept'
      })
    }
    return { name: curr, decision: 'kept' }
  }

  // Candidato é melhor
  if (WHATSAPP_DEBUG) {
    console.log('[NAME_UPDATE]', {
      company_id: company_id ?? null,
      telefoneTail: telefoneTail ?? null,
      currentName: (curr || '').slice(0, 30),
      candidateName: (cand || '').slice(0, 30),
      source,
      decision: 'updated'
    })
  }
  return { name: cand, decision: 'updated' }
}

function getDisplayName(cliente) {
  if (!cliente) return null
  const nome = cliente.nome && String(cliente.nome).trim()
  const pushname = cliente.pushname && String(cliente.pushname).trim()
  const telefone = cliente.telefone && String(cliente.telefone).trim()
  return nome || pushname || telefone || null
}

module.exports = {
  normalizeName,
  isBadName,
  scoreName,
  chooseBestName,
  getDisplayName
}
