/**
 * Orquestrador de proteção: volume, frequência e opt-in.
 * Proteções DESATIVADAS — envio livre para não bloquear o sistema.
 * Para reativar: remover o return antecipado em permitirEnvio.
 */

const { isEnabled, FLAGS } = require('../../helpers/featureFlags')
const supabase = require('../../config/supabase')
const { verificarIntervalo } = require('./frequenciaService')
const { verificarLimiteVolume } = require('./volumeService')
const { temOptIn } = require('./optInService')

// Proteções desativadas — permite envio imediato sem limite de volume, frequência ou opt-in
const PROTECAO_DESATIVADA = true

// Defaults: intervalo 1s evita duplo clique mas permite chat normal; volume evita spam
const DEFAULTS = {
  intervalo_seg: 1,      // 1s entre mensagens ao mesmo contato (chat fluido; campanhas usam config própria)
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
  if (PROTECAO_DESATIVADA) return { allow: true }

  const company_id = opts?.company_id ?? opts?.companyId
  if (!company_id) return { allow: true }

  try {
    const { data: emp } = await supabase
      .from('empresas')
      .select('intervalo_minimo_entre_mensagens_seg, limite_por_minuto, limite_por_hora')
      .eq('id', company_id)
      .maybeSingle()

    // Usa config da empresa. Null/undefined → defaults. 0 explícito → desativa a proteção.
    const rawIntervalo = emp?.intervalo_minimo_entre_mensagens_seg
    const rawLimiteMin = emp?.limite_por_minuto
    const rawLimiteHora = emp?.limite_por_hora
    let intervalo = rawIntervalo != null ? Number(rawIntervalo) : null
    let limiteMin = rawLimiteMin != null ? Number(rawLimiteMin) : null
    let limiteHora = rawLimiteHora != null ? Number(rawLimiteHora) : null

    if (!isEnabled(FLAGS.FEATURE_PROTECAO)) {
      // Empresa não configurou: usa defaults leves (chat fluido)
      if (intervalo == null) intervalo = DEFAULTS.intervalo_seg
      if (limiteMin == null || limiteMin <= 0) limiteMin = DEFAULTS.limite_por_minuto
      if (limiteHora == null || limiteHora <= 0) limiteHora = DEFAULTS.limite_por_hora
    } else {
      // FEATURE_PROTECAO: respeita exatamente o que empresa configurou (0 = desativado)
      intervalo = intervalo ?? 0
      limiteMin = limiteMin ?? 0
      limiteHora = limiteHora ?? 0
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
