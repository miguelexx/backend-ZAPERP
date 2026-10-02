/**
 * Fuso horário por estado (UF) do Brasil — mapeamento IANA centralizado.
 *
 * Fonte única da verdade para "qual timezone usar por empresa". Usado na validação
 * da config de atendimento (chatbot_triage) e reaproveitável por qualquer rotina que
 * precise do fuso da empresa. NÃO usa offset fixo (UTC-4) — só zonas IANA, para que
 * horário de verão / mudanças futuras fiquem corretos automaticamente.
 *
 * Regra: o horário configurado pela empresa (08:30, almoço, etc.) é SEMPRE o horário
 * local do estado dela. A conversão para o fuso acontece via Intl.DateTimeFormat com a
 * zona IANA — nunca com aritmética de horas.
 *
 * Estados com mais de um fuso (AM, PA, PE) expõem as opções; a primeira é o padrão.
 */

const DEFAULT_TIMEZONE = 'America/Sao_Paulo'

// UF → { nome, zones: [{ tz, label }] } (primeira zona = padrão do estado)
const BR_UF_TIMEZONES = {
  AC: { nome: 'Acre', zones: [{ tz: 'America/Rio_Branco', label: 'Horário do Acre (Rio Branco)' }] },
  AL: { nome: 'Alagoas', zones: [{ tz: 'America/Maceio', label: 'Horário de Brasília (Maceió)' }] },
  AP: { nome: 'Amapá', zones: [{ tz: 'America/Belem', label: 'Horário de Brasília (Belém)' }] },
  AM: {
    nome: 'Amazonas',
    zones: [
      { tz: 'America/Manaus', label: 'Horário do Amazonas (Manaus)' },
      { tz: 'America/Eirunepe', label: 'Oeste do Amazonas (Eirunepé)' },
    ],
  },
  BA: { nome: 'Bahia', zones: [{ tz: 'America/Bahia', label: 'Horário de Brasília (Salvador)' }] },
  CE: { nome: 'Ceará', zones: [{ tz: 'America/Fortaleza', label: 'Horário de Brasília (Fortaleza)' }] },
  DF: { nome: 'Distrito Federal', zones: [{ tz: 'America/Sao_Paulo', label: 'Horário de Brasília' }] },
  ES: { nome: 'Espírito Santo', zones: [{ tz: 'America/Sao_Paulo', label: 'Horário de Brasília' }] },
  GO: { nome: 'Goiás', zones: [{ tz: 'America/Sao_Paulo', label: 'Horário de Brasília' }] },
  MA: { nome: 'Maranhão', zones: [{ tz: 'America/Fortaleza', label: 'Horário de Brasília (Fortaleza)' }] },
  MT: { nome: 'Mato Grosso', zones: [{ tz: 'America/Cuiaba', label: 'Horário de Cuiabá' }] },
  MS: { nome: 'Mato Grosso do Sul', zones: [{ tz: 'America/Campo_Grande', label: 'Horário de Campo Grande' }] },
  MG: { nome: 'Minas Gerais', zones: [{ tz: 'America/Sao_Paulo', label: 'Horário de Brasília' }] },
  PA: {
    nome: 'Pará',
    zones: [
      { tz: 'America/Belem', label: 'Leste do Pará (Belém)' },
      { tz: 'America/Santarem', label: 'Oeste do Pará (Santarém)' },
    ],
  },
  PB: { nome: 'Paraíba', zones: [{ tz: 'America/Fortaleza', label: 'Horário de Brasília (Fortaleza)' }] },
  PR: { nome: 'Paraná', zones: [{ tz: 'America/Sao_Paulo', label: 'Horário de Brasília' }] },
  PE: {
    nome: 'Pernambuco',
    zones: [
      { tz: 'America/Recife', label: 'Horário de Brasília (Recife)' },
      { tz: 'America/Noronha', label: 'Fernando de Noronha' },
    ],
  },
  PI: { nome: 'Piauí', zones: [{ tz: 'America/Fortaleza', label: 'Horário de Brasília (Fortaleza)' }] },
  RJ: { nome: 'Rio de Janeiro', zones: [{ tz: 'America/Sao_Paulo', label: 'Horário de Brasília' }] },
  RN: { nome: 'Rio Grande do Norte', zones: [{ tz: 'America/Fortaleza', label: 'Horário de Brasília (Fortaleza)' }] },
  RS: { nome: 'Rio Grande do Sul', zones: [{ tz: 'America/Sao_Paulo', label: 'Horário de Brasília' }] },
  RO: { nome: 'Rondônia', zones: [{ tz: 'America/Porto_Velho', label: 'Horário de Porto Velho' }] },
  RR: { nome: 'Roraima', zones: [{ tz: 'America/Boa_Vista', label: 'Horário de Boa Vista' }] },
  SC: { nome: 'Santa Catarina', zones: [{ tz: 'America/Sao_Paulo', label: 'Horário de Brasília' }] },
  SP: { nome: 'São Paulo', zones: [{ tz: 'America/Sao_Paulo', label: 'Horário de Brasília' }] },
  SE: { nome: 'Sergipe', zones: [{ tz: 'America/Maceio', label: 'Horário de Brasília (Maceió)' }] },
  TO: { nome: 'Tocantins', zones: [{ tz: 'America/Araguaina', label: 'Horário de Brasília (Araguaína)' }] },
}

/** Set de todos os timezones mapeados (lookup rápido e reverso UF). */
const KNOWN_TZ = new Set()
for (const uf of Object.keys(BR_UF_TIMEZONES)) {
  for (const z of BR_UF_TIMEZONES[uf].zones) KNOWN_TZ.add(z.tz)
}

/** Normaliza/valida UF. Retorna sigla em maiúsculas conhecida, ou null. */
function normalizeUf(uf) {
  const v = String(uf || '').trim().toUpperCase()
  return Object.prototype.hasOwnProperty.call(BR_UF_TIMEZONES, v) ? v : null
}

/**
 * true se `tz` é um timezone IANA aceito pelo runtime (ICU). Valida qualquer zona,
 * não só as do Brasil, para não rejeitar config legada válida.
 */
function isValidTimezone(tz) {
  const v = String(tz || '').trim()
  if (!v) return false
  if (KNOWN_TZ.has(v)) return true
  try {
    // Lança RangeError se a zona não existir no ICU.
    new Intl.DateTimeFormat('en-US', { timeZone: v })
    return true
  } catch {
    return false
  }
}

/** Timezone padrão (primeira zona) de uma UF, ou null se UF desconhecida. */
function defaultTimezoneForUf(uf) {
  const v = normalizeUf(uf)
  return v ? BR_UF_TIMEZONES[v].zones[0].tz : null
}

/** Lista de timezones IANA válidos para a UF (primeiro = padrão). [] se UF desconhecida. */
function zonesForUf(uf) {
  const v = normalizeUf(uf)
  return v ? BR_UF_TIMEZONES[v].zones.map((z) => z.tz) : []
}

/** true se `tz` é uma das zonas da UF. */
function timezoneBelongsToUf(uf, tz) {
  return zonesForUf(uf).includes(String(tz || '').trim())
}

/**
 * Resolve o timezone efetivo a partir de UF + timezone informado.
 * - UF válida: respeita `tz` apenas se ele pertencer à UF (permite escolha em estados
 *   multi-fuso); caso contrário usa o fuso padrão da UF.
 * - Sem UF: usa `tz` se válido; senão o fallback.
 * Nunca retorna zona inválida.
 */
function resolveTimezoneForUf(uf, tz, fallback = DEFAULT_TIMEZONE) {
  const v = normalizeUf(uf)
  if (v) {
    return timezoneBelongsToUf(v, tz) ? String(tz).trim() : defaultTimezoneForUf(v)
  }
  return resolveTimezone(tz, fallback)
}

/** Primeira UF cujo conjunto de zonas inclui `tz` (lookup reverso para rótulo). */
function ufForTimezone(tz) {
  const v = String(tz || '').trim()
  if (!v) return null
  for (const uf of Object.keys(BR_UF_TIMEZONES)) {
    if (BR_UF_TIMEZONES[uf].zones.some((z) => z.tz === v)) return uf
  }
  return null
}

/** Rótulo amigável do fuso (ex.: "Horário de Cuiabá"); cai no próprio tz se desconhecido. */
function timezoneLabel(tz) {
  const v = String(tz || '').trim()
  for (const uf of Object.keys(BR_UF_TIMEZONES)) {
    const found = BR_UF_TIMEZONES[uf].zones.find((z) => z.tz === v)
    if (found) return found.label
  }
  return v || ''
}

/** Nome do estado por UF (ex.: "Mato Grosso"), ou '' se desconhecida. */
function ufNome(uf) {
  const v = normalizeUf(uf)
  return v ? BR_UF_TIMEZONES[v].nome : ''
}

/**
 * Resolve o timezone efetivo. Aceita um tz direto; se inválido/ausente, cai no fallback
 * (default: America/Sao_Paulo) — garante que empresas antigas sem config não quebrem.
 */
function resolveTimezone(tz, fallback = DEFAULT_TIMEZONE) {
  if (isValidTimezone(tz)) return String(tz).trim()
  return isValidTimezone(fallback) ? String(fallback).trim() : DEFAULT_TIMEZONE
}

module.exports = {
  DEFAULT_TIMEZONE,
  BR_UF_TIMEZONES,
  normalizeUf,
  isValidTimezone,
  defaultTimezoneForUf,
  zonesForUf,
  timezoneBelongsToUf,
  ufForTimezone,
  timezoneLabel,
  ufNome,
  resolveTimezone,
  resolveTimezoneForUf,
}
