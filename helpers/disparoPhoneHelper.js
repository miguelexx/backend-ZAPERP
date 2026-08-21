/**
 * Validação e normalização de telefone para o módulo Disparo de Mensagens.
 * Função centralizada e reutilizável — constrói sobre phoneHelper.js sem duplicar lógica.
 * Retorna estrutura detalhada com motivo de rejeição para exibir ao administrador.
 */

const { normalizePhoneBR } = require('./phoneHelper')

/** DDDs válidos do Brasil (atualizado 2025). */
const DDDS_VALIDOS = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19, // SP
  21, 22, 24,                          // RJ
  27, 28,                              // ES
  31, 32, 33, 34, 35, 37, 38,          // MG
  41, 42, 43, 44, 45, 46,              // PR
  47, 48, 49,                          // SC
  51, 53, 54, 55,                      // RS
  61,                                  // DF / GO
  62, 64,                              // GO
  63,                                  // TO
  65, 66,                              // MT
  67,                                  // MS
  68,                                  // AC
  69,                                  // RO
  71, 73, 74, 75, 77,                  // BA
  79,                                  // SE
  81, 82, 83, 84, 85, 86, 87, 88, 89, // NE
  91, 92, 93, 94, 95, 96, 97, 98, 99, // Norte
])

/**
 * Valida e normaliza um número de telefone para uso no disparo de mensagens.
 *
 * Regras:
 * - Remove espaços, parênteses, traços e caracteres não-numéricos
 * - Reconhece números com ou sem código do país (+55 ou 55)
 * - Aplica o código 55 quando o número tem 10 ou 11 dígitos (claramente BR)
 * - Valida DDD e quantidade de dígitos
 * - Não corrige silenciosamente números ambíguos ou inválidos
 *
 * @param {string} raw - telefone bruto da planilha ou formulário
 * @returns {{ original: string, normalizado: string|null, valido: boolean, motivo?: string }}
 */
function validarTelefoneDisparo(raw) {
  const original = String(raw ?? '').trim()

  if (!original) {
    return { original, normalizado: null, valido: false, motivo: 'Telefone ausente' }
  }

  const digits = original.replace(/\D/g, '')
  if (!digits) {
    return { original, normalizado: null, valido: false, motivo: 'Telefone inválido (sem dígitos)' }
  }

  // Rejeita strings puramente numéricas muito longas (ex.: códigos de barras copiados por engano)
  if (digits.length > 15) {
    return { original, normalizado: null, valido: false, motivo: 'Telefone inválido (número muito longo)' }
  }

  const normalizado = normalizePhoneBR(original)
  if (!normalizado) {
    return {
      original,
      normalizado: null,
      valido: false,
      motivo: `Telefone inválido (${digits.length} dígitos — esperado 10 a 13)`,
    }
  }

  const nd = normalizado.replace(/\D/g, '')
  // normalizePhoneBR garante que começa com 55 e tem 12 ou 13 dígitos
  if (nd.length !== 12 && nd.length !== 13) {
    return {
      original,
      normalizado: null,
      valido: false,
      motivo: `Telefone inválido (${nd.length} dígitos após normalização)`,
    }
  }

  const ddd = Number(nd.slice(2, 4))
  if (!DDDS_VALIDOS.has(ddd)) {
    return {
      original,
      normalizado: null,
      valido: false,
      motivo: `DDD inválido (${ddd})`,
    }
  }

  return { original, normalizado, valido: true }
}

module.exports = { validarTelefoneDisparo, DDDS_VALIDOS }
