/**
 * Política PURA de reabertura de conversa encerrada ao chegar novo inbound.
 * Extraído de controllers/webhookZapiController.js (Fase 1 — doc 24) sem alteração de comportamento.
 */

const { parseNota } = require('../../services/avaliacaoService')

function normalizeReopenText(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s!?.,]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Decide se conversa encerrada deve reabrir ao receber nova mensagem do cliente.
 * Regra: reabrir por defeito; manter fechada só para nota de avaliação (0-10),
 * agradecimentos / ACKs de encerramento ou frases que indicam ausência de nova demanda.
 */
function shouldReopenFinishedConversation(message, context = {}) {
  const raw = String(message || '').trim()
  const normalized = normalizeReopenText(message)
  const compact = normalized.replace(/[!?.,]/g, '').trim()

  if (!compact) {
    return { shouldReopen: false, reason: 'empty_or_symbols_only', normalized }
  }

  // Mesma regra do avaliacaoService: só dígitos 0-10 — não reabre (avaliação ou tentativa)
  if (/^\d{1,2}$/.test(compact) && parseNota(raw) !== null) {
    return { shouldReopen: false, reason: 'evaluation_score_0_10', normalized }
  }

  const stayClosedPatterns = [
    /^(ok|okay|blz|blza|beleza|certo|certinho|certim|entendi|entendido|perfeito|show|sim|nao|não|ta|t[áa]|combinado|fechado|otim[oa]|isso|joia|jóia)$/,
    /^(isso mesmo|show de bola|tudo certinho|ta certinho|t[áa] certinho|ok certinho|era isso mesmo)$/,
    /^(obrigad[oa]|muito obrigad[oa]|valeu|vlw|obg|brigad[oa]|obgd|agrade[cç]o|grat[oa]|thanks|thank you|ty|thx)$/,
    /^(obrigad[oa] pela ajuda|muito obrigad[oa] pela ajuda)$/,
    // Agradecimento + vocativo / reforço curto (ex.: "obrigada vc", "valeu voce", "brigada tbm") — não reabrir menu
    /^obrigad[oa]\s+(vc|voce|tbm|tb|tambem|demais|tbem)(\s+(vc|voce|tbm|tb|tambem))?$/,
    /^muito\s+obrigad[oa]\s+(vc|voce|tbm|tb|tambem|demais)?$/,
    /^obrigad[oa]\s+(a|pra|para)\s+(vc|voce)$/,
    /^brigad[oa]\s+(vc|voce|tbm|tb|tambem)?$/,
    /^valeu\s+(vc|voce|tbm|tb|tambem|demais)$/,
    /^vlw\s+(vc|voce|tbm|tb)?$/,
    /^obg\s+(vc|voce|tbm|tb|demais)?$/,
    /^(tchau|xau|ate mais|ate logo|ate breve|flw|falou)$/,
    /^(so|só) isso[!., ]*$/,
    /^(nada mais|era (so|só) isso)[!. ]*$/,
    /^(so|só) (um )?(obrigad[oa]|agradecimento|agradecer)$/,
    /^(so|só|apenas) (pra|para) agradecer$/,
    /^pra agradecer$/,
    /^ok[,!. ]+(valeu|obrigad[oa]|vlw|obg)\b/,
    /^(bom|boa)(,)? (obrigad[oa]|valeu|vlw)\b/,
    /^(ate mais|ate logo).{0,20}(obrigad[oa]|valeu|vlw)\b/,
    /^(tudo resolvido|problema resolvido|deu certo|tudo certo)$/
  ]

  if (stayClosedPatterns.some((rx) => rx.test(compact))) {
    return { shouldReopen: false, reason: 'thanks_or_closing_ack', normalized }
  }

  // Frase curta só de cortesia: poucas palavras conhecidas, sem sinais de nova demanda
  const palavrasCortesia = new Set([
    'ok', 'okay', 'blz', 'blza', 'beleza', 'certo', 'certinho', 'certim', 'entendi', 'entendido', 'perfeito', 'show', 'sim', 'nao', 'ta', 'obrigada', 'obrigado',
    'combinado', 'fechado', 'otimo', 'otima', 'isso', 'mesmo', 'joia',
    'muito', 'valeu', 'vlw', 'obg', 'brigada', 'brigado', 'obgd', 'agradeco', 'grato', 'grata', 'thanks', 'thank', 'you', 'ty', 'thx',
    'tchau', 'xau', 'ate', 'mais', 'logo', 'breve', 'flw', 'falou', 'vc', 'voce', 'tbm', 'tb', 'tambem', 'demais',
    'tbem', 'pra', 'para', 'a', 'igualmente', 'disponha', 'imagina', 'de', 'nada', 'por', 'tudo', 'pela', 'pelo',
    'atencao', 'atendimento', 'preferencia', 'carinho', 'ajuda', 'info',
  ])
  const sinaisDemanda =
    /\b(preciso|precisar|precisa|quero|gostaria|poderia|pode\s+me|d[uú]vida|problema|reclama|cancelar|devolver|trocar|defeito|or[çc]amento|orcamento|pedido|entrega|atraso|valor|pre[çc]o|preco|como\s+(fa[çc]o|posso|fazer)|onde|quando|urgente)\b/i
  const tokens = compact.split(/\s+/).filter(Boolean)
  if (tokens.length > 0 && tokens.length <= 6 && compact.length <= 72 && !sinaisDemanda.test(compact)) {
    const soCortesia = tokens.every((w) => palavrasCortesia.has(w))
    if (soCortesia) {
      return { shouldReopen: false, reason: 'thanks_or_closing_ack_short', normalized }
    }
  }

  return { shouldReopen: true, reason: 'default_reopen_after_close', normalized }
}

/**
 * Texto estável para comparar eco de outbound (markdown/asteriscos do WhatsApp).
 */
function normalizeEchoText(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[*_`~]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function inboundLooksLikeRecentOutbound(inboundText, outboundTexts = []) {
  const inbound = normalizeEchoText(inboundText)
  if (!inbound || inbound.length < 8) return false
  for (const out of outboundTexts) {
    const outbound = normalizeEchoText(out)
    if (!outbound || outbound.length < 8) continue
    if (inbound === outbound) return true
    if (inbound.length >= 24 && outbound.length >= 24) {
      if (inbound.includes(outbound) || outbound.includes(inbound)) return true
      const n = Math.min(48, inbound.length, outbound.length)
      if (n >= 24 && inbound.slice(0, n) === outbound.slice(0, n)) return true
    }
  }
  return false
}

function looksLikeAtendimentoFinalizacao(texto) {
  const t = normalizeEchoText(texto)
  if (!t) return false
  if (t.includes('atendimento finalizado')) return true
  if (t.includes('segue seu protocolo')) return true
  if (/\bprotocolo\b/.test(t) && /\b(finalizado|finalizacao|encerrado|encerrada)\b/.test(t)) return true
  return false
}

function looksLikeWelcomeMenuEcho(texto) {
  const t = normalizeEchoText(texto)
  if (!t) return false
  if (t.includes('seja bem vindo') || t.includes('seja bemvindo')) return true
  if (t.includes('escolha o setor')) return true
  if (t.includes('setor com o qual deseja')) return true
  return false
}

/**
 * Eco da nossa mensagem de encerramento/boas-vindas não deve reabrir nem disparar o menu.
 * Demanda real do cliente continua reabrindo via shouldReopenFinishedConversation.
 */
function shouldSkipReopenAsOwnOutboundEcho({ inboundText, recentOutboundTexts = [] } = {}) {
  if (looksLikeAtendimentoFinalizacao(inboundText)) {
    return { skip: true, reason: 'finalizacao_template' }
  }
  if (looksLikeWelcomeMenuEcho(inboundText)) {
    return { skip: true, reason: 'welcome_menu_echo' }
  }
  if (inboundLooksLikeRecentOutbound(inboundText, recentOutboundTexts)) {
    return { skip: true, reason: 'echo_recent_outbound' }
  }
  return { skip: false, reason: null }
}

module.exports = {
  normalizeReopenText,
  shouldReopenFinishedConversation,
  normalizeEchoText,
  inboundLooksLikeRecentOutbound,
  looksLikeAtendimentoFinalizacao,
  looksLikeWelcomeMenuEcho,
  shouldSkipReopenAsOwnOutboundEcho,
}
