/**
 * Fuso horário da empresa — leitura/escrita do par (estado, timezone).
 *
 * Fonte única da verdade: `ia_config.config.chatbot_triage.{estado,timezone}` (ver
 * helpers/brazilTimezones.js e services/chatbotTriageService.js). NÃO existe coluna
 * `estado`/`timezone` em `empresas` — e não deve existir, para não criar duas verdades:
 * horário comercial, almoço, SLA, alerta sem resposta e finalização por ausência já leem
 * daqui. Este helper só expõe esse par para a tela de Configurações → Geral, que é onde o
 * admin escolhe o estado da empresa.
 *
 * Nunca grava zona inválida: a UF manda no fuso (respeitando a escolha em estados
 * multi-fuso: AM, PA, PE) e o fallback é America/Sao_Paulo.
 */

const supabase = require('../config/supabase')
const {
  DEFAULT_TIMEZONE,
  normalizeUf,
  resolveTimezone,
  resolveTimezoneForUf,
  timezoneLabel,
  ufNome,
} = require('./brazilTimezones')

/** Lê `ia_config.config` da empresa. Retorna {} quando não há linha/tabela. */
async function lerIaConfig(company_id) {
  try {
    const { data, error } = await supabase
      .from('ia_config')
      .select('config')
      .eq('company_id', company_id)
      .maybeSingle()
    if (error) {
      // Tabela ausente ou erro de leitura não pode derrubar GET /config/empresa — o fuso
      // cai no padrão e o resto da tela continua funcionando.
      console.warn('[empresaTimezone] ia_config select:', error?.message || error)
      return null
    }
    return data?.config && typeof data.config === 'object' ? data.config : {}
  } catch (err) {
    console.warn('[empresaTimezone] ia_config select:', err?.message || err)
    return null
  }
}

/**
 * Fuso configurado da empresa, pronto para a UI.
 * @returns {Promise<{estado: string, estado_nome: string, timezone: string, timezone_label: string}>}
 */
async function getEmpresaTimezone(company_id) {
  const config = await lerIaConfig(company_id)
  const ct = config && typeof config.chatbot_triage === 'object' && config.chatbot_triage
    ? config.chatbot_triage
    : {}
  return descreverFuso(ct.estado, ct.timezone)
}

/**
 * Grava o par (estado, timezone) preservando o resto de `chatbot_triage`.
 * `estado` vazio = empresa sem UF definida (volta para o padrão de Brasília).
 * @returns {Promise<{estado, estado_nome, timezone, timezone_label}>} o que ficou gravado
 */
async function setEmpresaTimezone(company_id, { estado, timezone } = {}) {
  const config = await lerIaConfig(company_id)
  // null = a leitura falhou. Gravar aqui substituiria a config inteira (bot, roteamento,
  // triagem) por um objeto só com o fuso — melhor devolver erro e não gravar nada.
  if (config === null) {
    const err = new Error('Não foi possível ler a configuração atual para salvar o fuso horário.')
    err.code = 'EMPRESA_TIMEZONE_READ'
    throw err
  }
  const ctAtual = typeof config.chatbot_triage === 'object' && config.chatbot_triage
    ? config.chatbot_triage
    : {}

  const alvo = descreverFuso(estado, timezone)
  const merged = {
    ...config,
    chatbot_triage: { ...ctAtual, estado: alvo.estado, timezone: alvo.timezone },
  }

  const { error } = await supabase
    .from('ia_config')
    .upsert(
      { company_id, config: merged, updated_at: new Date().toISOString() },
      { onConflict: 'company_id' }
    )
  if (error) {
    const err = new Error(error.message || 'Erro ao salvar fuso horário')
    err.code = 'EMPRESA_TIMEZONE_WRITE'
    throw err
  }

  invalidarCacheChatbot(company_id)
  return alvo
}

/**
 * true se o par informado é diferente do que já está gravado — evita reescrever
 * `ia_config` (e invalidar o cache do chatbot) a cada "Salvar configurações gerais".
 */
function fusoMudou(atual, proximo) {
  return atual.estado !== proximo.estado || atual.timezone !== proximo.timezone
}

/** Normaliza (estado, timezone) e devolve os rótulos para a UI. Nunca lança. */
function descreverFuso(estado, timezone) {
  const uf = normalizeUf(estado) || ''
  const tz = uf
    ? resolveTimezoneForUf(uf, timezone)
    : resolveTimezone(timezone, DEFAULT_TIMEZONE)
  return {
    estado: uf,
    estado_nome: uf ? ufNome(uf) : '',
    timezone: tz,
    timezone_label: timezoneLabel(tz) || tz,
  }
}

/** Cache do chatbot guarda a config por empresa; sem isso o fuso novo só valeria após TTL. */
function invalidarCacheChatbot(company_id) {
  try {
    // require tardio de propósito: chatbotTriageService é pesado e puxa a cadeia de
    // providers/IA. Carregá-lo no topo deste helper arrastaria tudo isso para dentro do
    // configController (e para o boot da API).
    const { invalidateChatbotConfigCache } = require('../services/chatbotTriageService')
    if (typeof invalidateChatbotConfigCache === 'function') invalidateChatbotConfigCache(company_id)
  } catch (err) {
    console.warn('[empresaTimezone] invalidateChatbotConfigCache:', err?.message || err)
  }
}

module.exports = {
  getEmpresaTimezone,
  setEmpresaTimezone,
  descreverFuso,
  fusoMudou,
}
