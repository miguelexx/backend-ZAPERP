/**
 * Orquestrador de proteção: volume, frequência e opt-in.
 * SEMPRE ativo para evitar bloqueio do WhatsApp — usa defaults seguros quando empresa não configurou.
 * FEATURE_PROTECAO=1: usa config da empresa; =0: usa apenas defaults conservadores (5s, 40/min, 400/h).
 */

const { isEnabled, FLAGS } = require('../../helpers/featureFlags')
const supabase = require('../../config/supabase')
const { verificarIntervalo } = require('./frequenciaService')
const { verificarLimiteVolume } = require('./volumeService')
const { temOptIn } = require('./optInService')

// Defaults conservadores para reduzir risco de bloqueio (WhatsApp detecta picos e spam)
const DEFAULTS = {
  intervalo_seg: 5,      // 5s entre mensagens ao mesmo contato
  limite_por_minuto: 40,
  limite_por_hora: 400,
}

/**
 * Verifica se o envio está permitido conforme proteções da empresa.
 * @param {object} opts
 * @param {number} opts.company_id
 * @param {number} [opts.conversa_id] - para verificar intervalo por contato
 * @param {number} [opts.cliente_id] - para verificar opt-in (quando requireOptIn=true)
 * @param {boolean} [opts.requireOptIn=false] - exige opt-in (envio comercial/campanha)
 * @returns {Promise<{ allow: boolean, reason?: string }>}
 */
async function permitirEnvio(opts = {}) {
  const company_id = opts?.company_id ?? opts?.companyId
  if (!company_id) return { allow: true }

  try {
    const { data: emp } = await supabase
      .from('empresas')
      .select('intervalo_minimo_entre_mensagens_seg, limite_por_minuto, limite_por_hora')
      .eq('id', company_id)
      .maybeSingle()

    // Usa config da empresa; quando 0, aplica defaults seguros (anti-bloqueio)
    let intervalo = Number(emp?.intervalo_minimo_entre_mensagens_seg)
    let limiteMin = Number(emp?.limite_por_minuto)
    let limiteHora = Number(emp?.limite_por_hora)

    if (!isEnabled(FLAGS.FEATURE_PROTECAO)) {
      // Proteção básica sempre ativa: defaults conservadores quando empresa não configurou
      if (!intervalo || intervalo <= 0) intervalo = DEFAULTS.intervalo_seg
      if (!limiteMin || limiteMin <= 0) limiteMin = DEFAULTS.limite_por_minuto
      if (!limiteHora || limiteHora <= 0) limiteHora = DEFAULTS.limite_por_hora
    } else {
      intervalo = intervalo || 0
      limiteMin = limiteMin || 0
      limiteHora = limiteHora || 0
    }

    // Volume (por empresa)
    if (limiteMin > 0 || limiteHora > 0) {
      const vol = await verificarLimiteVolume(company_id, limiteMin > 0 ? limiteMin : null, limiteHora > 0 ? limiteHora : null)
      if (!vol.ok) {
        return {
          allow: false,
          reason: (limiteMin > 0 && vol.countMin >= limiteMin)
            ? 'Limite de mensagens por minuto atingido. Aguarde alguns segundos.'
            : 'Limite de mensagens por hora atingido. Tente mais tarde.',
        }
      }
    }

    // Frequência (por contato) — intervalo mínimo entre envios ao mesmo contato
    const conversa_id = opts?.conversa_id ?? opts?.conversaId
    if (intervalo > 0 && conversa_id) {
      const freq = await verificarIntervalo(company_id, conversa_id, intervalo)
      if (!freq.ok) {
        const msg = intervalo >= 60
          ? `Aguarde ${Math.ceil(intervalo / 60)} minuto(s) entre mensagens ao mesmo contato.`
          : 'Aguarde alguns segundos entre mensagens ao mesmo contato.'
        return { allow: false, reason: msg }
      }
    }

    // Opt-in (quando envio comercial exige)
    if (opts?.requireOptIn && opts?.cliente_id) {
      const tem = await temOptIn(company_id, opts.cliente_id)
      if (!tem) {
        return { allow: false, reason: 'Contato não possui opt-in para envio comercial.' }
      }
    }

    return { allow: true }
  } catch (e) {
    console.warn('[protecaoOrchestrator] Erro na verificação — permitindo envio (fail open):', e?.message || e)
    return { allow: true }
  }
}

module.exports = { permitirEnvio }
