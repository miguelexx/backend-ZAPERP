'use strict'

/**
 * Ranking gamificado — regras PURAS (sem banco, sem relógio implícito).
 *
 * 1) Período: quando termina um ciclo semanal, no fuso da empresa.
 * 2) Classificação: posição de cada atendente a partir das linhas de `atendimentos`.
 *
 * A contagem segue a regra que a Supervisão já usa em "Finalizadas hoje"
 * (services/supervisaoService.js): cada linha `atendimentos.acao = 'encerrou'` vale 1 para
 * `de_usuario_id` (quem encerrou). Transferido → conta para quem encerrou. Reaberto e
 * encerrado de novo → cada encerramento conta (igual à Supervisão). Finalização automática
 * por ausência não grava `encerrou` → não conta para ninguém. Mensagens nunca contam.
 */

const DIA_MS = 24 * 60 * 60 * 1000
/** Ciclo nunca nasce mais curto que isto: ativar sexta 17h não cria uma "semana" de 1 hora. */
const DURACAO_MINIMA_CICLO_MS = DIA_MS
const HORARIO_RE = /^([01]\d|2[0-3]):([0-5]\d)$/
const DIAS_SEMANA = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado']
const WEEKDAY_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function normalizarHorario(valor) {
  const raw = String(valor ?? '').trim()
  const m = raw.match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return null
  const hh = m[1].padStart(2, '0')
  const out = `${hh}:${m[2]}`
  return HORARIO_RE.test(out) ? out : null
}

function normalizarDiaSemana(valor) {
  if (valor === null || valor === undefined || valor === '') return null
  const n = Number(valor)
  return Number.isInteger(n) && n >= 0 && n <= 6 ? n : null
}

function fusoValido(timezone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0)
    return true
  } catch {
    return false
  }
}

/** Data/hora de parede de um instante num fuso IANA. */
function partesNoFuso(instanteMs, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(new Date(instanteMs))
  const get = (type) => parts.find((p) => p.type === type)?.value || ''
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    weekday: WEEKDAY_EN.indexOf(get('weekday')),
  }
}

/**
 * Converte um horário de parede (no fuso) para o instante UTC.
 * Duas passadas de correção cobrem fusos com horário de verão.
 */
function horarioDeParedeParaUtc({ year, month, day, hour, minute }, timezone) {
  const alvo = Date.UTC(year, month - 1, day, hour, minute)
  let palpite = alvo
  for (let i = 0; i < 3; i += 1) {
    const p = partesNoFuso(palpite, timezone)
    const visto = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute)
    const diff = visto - alvo
    if (diff === 0) break
    palpite -= diff
  }
  return new Date(palpite)
}

/**
 * Fim do ciclo que começa em `inicio`: a primeira ocorrência de (diaSemana, horario) no fuso
 * que fique a pelo menos `duracaoMinimaMs` do início.
 *
 * - Ciclo semanal contínuo (início = fim anterior, mesma regra) → exatamente 7 dias depois.
 * - Primeiro ciclo após ativar (quarta 10h, regra sexta 18h) → esta sexta 18h.
 * - Ativou sexta 17h → a sexta seguinte (o ciclo não nasce com 1 hora).
 * - Regra mudou para quarta → o próximo ciclo termina na quarta seguinte ao início.
 */
function calcularFimDoCiclo(inicio, { diaSemana, horario }, timezone, { duracaoMinimaMs = DURACAO_MINIMA_CICLO_MS } = {}) {
  const dia = normalizarDiaSemana(diaSemana)
  const hhmm = normalizarHorario(horario)
  if (dia == null) throw new Error('dia_semana inválido')
  if (!hhmm) throw new Error('horario inválido')
  const tz = fusoValido(timezone) ? timezone : 'America/Sao_Paulo'
  const inicioMs = new Date(inicio).getTime()
  if (!Number.isFinite(inicioMs)) throw new Error('inicio inválido')

  const limiteMs = inicioMs + Math.max(0, Number(duracaoMinimaMs) || 0)
  const [hour, minute] = hhmm.split(':').map(Number)
  const base = partesNoFuso(limiteMs, tz)
  const baseDia = Date.UTC(base.year, base.month - 1, base.day)

  for (let i = 0; i <= 8; i += 1) {
    const d = new Date(baseDia + i * DIA_MS)
    if (d.getUTCDay() !== dia) continue
    const candidato = horarioDeParedeParaUtc(
      { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour, minute },
      tz
    )
    if (candidato.getTime() >= limiteMs) return candidato
  }
  // Inalcançável na prática (8 dias sempre contêm o dia da semana); fallback defensivo.
  return new Date(limiteMs + 7 * DIA_MS)
}

/**
 * Classificação a partir das linhas `atendimentos` (já filtradas: empresa, acao='encerrou',
 * janela do ciclo). Linhas sem `de_usuario_id` são ignoradas.
 *
 * Posição "de competição": empatados dividem a posição e a seguinte pula (1, 1, 3).
 * Vencedores = TODOS na 1ª posição com pelo menos 1 atendimento — sem desempate arbitrário.
 * A ordem entre empatados (nome) é só de exibição; não muda a posição.
 *
 * @param {Array<{de_usuario_id:number|null}>} linhas
 * @param {Record<string,string>} nomes  id → nome
 */
function montarClassificacao(linhas, nomes = {}) {
  const totais = new Map()
  for (const row of linhas || []) {
    const id = Number(row?.de_usuario_id)
    if (!Number.isInteger(id) || id <= 0) continue
    totais.set(id, (totais.get(id) || 0) + 1)
  }

  const lista = [...totais.entries()].map(([usuario_id, total]) => ({
    usuario_id,
    nome: String(nomes[usuario_id] ?? nomes[String(usuario_id)] ?? '').trim() || 'Atendente',
    total,
  }))
  lista.sort((a, b) => b.total - a.total || a.nome.localeCompare(b.nome, 'pt-BR') || a.usuario_id - b.usuario_id)

  let posicaoAtual = 0
  let totalAnterior = null
  lista.forEach((item, index) => {
    if (item.total !== totalAnterior) {
      posicaoAtual = index + 1
      totalAnterior = item.total
    }
    item.posicao = posicaoAtual
  })

  const vencedores = lista.filter((item) => item.posicao === 1 && item.total > 0)
  return {
    classificacao: lista,
    vencedores,
    total_vencedor: vencedores.length > 0 ? vencedores[0].total : 0,
    total_atendimentos: lista.reduce((acc, item) => acc + item.total, 0),
  }
}

function descreverEncerramento(diaSemana, horario) {
  const dia = normalizarDiaSemana(diaSemana)
  const hhmm = normalizarHorario(horario)
  if (dia == null || !hhmm) return ''
  const [h, m] = hhmm.split(':')
  const hora = m === '00' ? `${Number(h)}h` : `${Number(h)}h${m}`
  return `${DIAS_SEMANA[dia]}, às ${hora}`
}

module.exports = {
  DURACAO_MINIMA_CICLO_MS,
  DIAS_SEMANA,
  normalizarHorario,
  normalizarDiaSemana,
  fusoValido,
  partesNoFuso,
  horarioDeParedeParaUtc,
  calcularFimDoCiclo,
  montarClassificacao,
  descreverEncerramento,
}
