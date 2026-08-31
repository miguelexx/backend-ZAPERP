'use strict'

const { LEXICO_CORDIAL_POSITIVO, LEXICO_CORDIAL_NEGATIVO } = require('./lexicos')
const { normalizeSearchTerm, textoCasaTermoRobusto } = require('./searchText')

/**
 * Recebe array de mensagens { conversa_id, criado_em, direcao }
 * e retorna Map< conversa_id → msgs[] > ordenado por criado_em ASC.
 */
function buildMsgsByConv(msgs) {
  const map = new Map()
  for (const m of msgs || []) {
    const ts = new Date(m.criado_em).getTime()
    if (!m.conversa_id || Number.isNaN(ts)) continue
    if (!map.has(m.conversa_id)) map.set(m.conversa_id, [])
    map.get(m.conversa_id).push({ ts, direcao: m.direcao })
  }
  for (const arr of map.values()) arr.sort((a, b) => a.ts - b.ts)
  return map
}

/**
 * Para um array de mensagens de UMA conversa (ordenado),
 * retorna { diffMin } ou null se não houver par in/out válido.
 */
function calcFirstResponseDiff(msgs) {
  const firstIn = msgs.find((m) => m.direcao === 'in')
  if (!firstIn) return null
  const firstOut = msgs.find((m) => m.direcao === 'out' && m.ts >= firstIn.ts)
  if (!firstOut) return null
  const diffMin = (firstOut.ts - firstIn.ts) / 60000
  return diffMin >= 0 ? diffMin : null
}

async function fetchMensagensPaged(buildQuery, { pageSize = 2000, maxRows = 30000 } = {}) {
  const rows = []
  let from = 0
  while (from < maxRows) {
    const to = Math.min(from + pageSize - 1, maxRows - 1)
    const { data, error } = await buildQuery(from, to)
    if (error) throw error
    const batch = data || []
    rows.push(...batch)
    if (batch.length < pageSize) break
    from += pageSize
  }
  return rows
}

function contarOcorrenciasNoTexto(texto, lexico) {
  const t = normalizeSearchTerm(String(texto || ''))
  if (!t) return 0
  let n = 0
  for (const termo of lexico) {
    if (textoCasaTermoRobusto(t, termo)) n++
  }
  return n
}

function notaCordialidadePorMensagem(texto) {
  const positivos = contarOcorrenciasNoTexto(texto, LEXICO_CORDIAL_POSITIVO)
  const negativos = contarOcorrenciasNoTexto(texto, LEXICO_CORDIAL_NEGATIVO)
  return { positivos, negativos }
}

const RE_AUTO = /(escolha (um |o )?setor|digite (o |a )?n[uú]mero|menu principal|bem[-\s]?vindo|assistente virtual|chatbot|protocolo|avali(ar|e) (o |nosso )?atendimento|encerr(amos|ada)|transfer(ido|ência)|op[cç][aã]o inv[aá]lida)/i

function classificarMensagemParaResumo(m) {
  const tipo = String(m.tipo || 'texto').toLowerCase()
  const t = String(m.texto || '').trim()
  const tl = t.toLowerCase()
  const ehMidia = !!(m.url || m.nome_arquivo || ['imagem', 'image', 'audio', 'video', 'documento', 'sticker', 'location', 'ptt', 'document'].includes(tipo))
  let provavel_automatica = false
  if (!ehMidia && t.length > 0) {
    if (RE_AUTO.test(t)) provavel_automatica = true
    if (/^\d{1,2}\s*[-–.)]\s*\S/.test(tl) && t.length < 160) provavel_automatica = true
  }
  const sinal_baixo_valor = !ehMidia && t.length > 0 && t.length <= 4 && /^(oi|ok|opa|sim|n[aã]o|👍|👋)$/i.test(t)
  let peso_resumo = 2
  if (ehMidia) peso_resumo = 3
  else if (provavel_automatica) peso_resumo = 0
  else if (sinal_baixo_valor) peso_resumo = 1
  return {
    eh_midia: ehMidia,
    provavel_automatica,
    sinal_baixo_valor_informativo: sinal_baixo_valor,
    peso_resumo,
  }
}

function dedupeMensagensConsecutivasSemelhantes(mensagens) {
  const out = []
  let prev = null
  for (const m of mensagens || []) {
    const key = `${m.direcao}|${String(m.texto || '').trim().replace(/\s+/g, ' ').toLowerCase()}`
    if (prev === key) continue
    prev = key
    out.push(m)
  }
  return out
}

module.exports = {
  buildMsgsByConv,
  calcFirstResponseDiff,
  fetchMensagensPaged,
  contarOcorrenciasNoTexto,
  notaCordialidadePorMensagem,
  RE_AUTO,
  classificarMensagemParaResumo,
  dedupeMensagensConsecutivasSemelhantes,
}
