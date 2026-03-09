/**
 * Orquestrador de proteção: volume, frequência e opt-in.
 * Ativado por FEATURE_PROTECAO=1.
 * Falha nas verificações → bloqueia envio.
 * Erro no módulo → permite envio (fail open).
 */

const { isEnabled, FLAGS } = require('../../helpers/featureFlags')
const supabase = require('../../config/supabase')
const { verificarIntervalo } = require('./frequenciaService')
const { verificarLimiteVolume } = require('./volumeService')
const { temOptIn } = require('./optInService')

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
  if (!isEnabled(FLAGS.FEATURE_PROTECAO)) return { allow: true }
  const company_id = opts?.company_id ?? opts?.companyId
  if (!company_id) return { allow: true }

  try {
    const { data: emp } = await supabase
      .from('empresas')
      .select('intervalo_minimo_entre_mensagens_seg, limite_por_minuto, limite_por_hora')
      .eq('id', company_id)
      .maybeSingle()
    if (!emp) return { allow: true }

    const intervalo = Number(emp.intervalo_minimo_entre_mensagens_seg) || 0
    const limiteMin = Number(emp.limite_por_minuto) || 0
    const limiteHora = Number(emp.limite_por_hora) || 0

    // Volume (por empresa)
    if (limiteMin > 0 || limiteHora > 0) {
      const vol = await verificarLimiteVolume(company_id, limiteMin || null, limiteHora || null)
      if (!vol.ok) {
        return {
          allow: false,
          reason: vol.countMin >= (limiteMin || 0)
            ? 'Limite de mensagens por minuto atingido. Aguarde alguns segundos.'
            : 'Limite de mensagens por hora atingido. Tente mais tarde.',
        }
      }
    }

    // Frequência (por contato) — só quando conversa_id informado
    const conversa_id = opts?.conversa_id ?? opts?.conversaId
    if (intervalo > 0 && conversa_id) {
      const freq = await verificarIntervalo(company_id, conversa_id, intervalo)
      if (!freq.ok) {
        return {
          allow: false,
          reason: `Aguarde ${Math.ceil(intervalo / 60)} minuto(s) entre mensagens ao mesmo contato.`,
        }
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
