'use strict'

const RECORTE_TZ = 'America/Sao_Paulo'

function calendarKeyInTz(iso, tz = RECORTE_TZ) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}

function formatDateTimeBR(iso, tz = RECORTE_TZ) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  return d.toLocaleString('pt-BR', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' })
}

function calendarKeyToBRLabel(yyyyMmDd) {
  if (!yyyyMmDd || !/^\d{4}-\d{2}-\d{2}$/.test(yyyyMmDd)) return yyyyMmDd
  const [y, m, d] = yyyyMmDd.split('-')
  return `${d}/${m}/${y}`
}

/** Início do dia civil (yyyy-mm-dd) em `tz`, como instante UTC (ms). America/Sao_Paulo sem DST desde 2019. */
function startOfZonedDayUtcMs(tz, y, m, d) {
  const pad = (n) => String(n).padStart(2, '0')
  const target = `${y}-${pad(m)}-${pad(d)}`
  let anchor = null
  for (let h = -14; h <= 38; h++) {
    const ms = Date.UTC(y, m - 1, d, h, 0, 0)
    const key = calendarKeyInTz(new Date(ms).toISOString(), tz)
    if (key === target) {
      anchor = ms
      break
    }
  }
  if (anchor == null) return Date.UTC(y, m - 1, d, 3, 0, 0)
  let s = anchor
  while (s > 0 && calendarKeyInTz(new Date(s - 1000).toISOString(), tz) === target) s -= 1000
  return s
}

function startIsoFromCalendarKey(tz, key) {
  if (!key || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return null
  const [y, m, d] = key.split('-').map(Number)
  return new Date(startOfZonedDayUtcMs(tz, y, m, d)).toISOString()
}

function addDaysToCalendarKey(key, delta) {
  const [y, mo, da] = key.split('-').map(Number)
  const ms0 = startOfZonedDayUtcMs(RECORTE_TZ, y, mo, da)
  const ms1 = ms0 + Number(delta) * 86400000
  return calendarKeyInTz(new Date(ms1).toISOString(), RECORTE_TZ)
}

function endExclusiveIsoFromCalendarKey(tz, key) {
  const next = addDaysToCalendarKey(key, 1)
  return startIsoFromCalendarKey(tz, next)
}

/** Limites [inicio, fim) para um dia civil em America/Sao_Paulo a partir de YYYY-MM-DD. */
function dayBoundsSpForIsoDate(yyyyMmDd) {
  if (!yyyyMmDd || typeof yyyyMmDd !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(yyyyMmDd)) return null
  return {
    inicio: startIsoFromCalendarKey(RECORTE_TZ, yyyyMmDd),
    fim: endExclusiveIsoFromCalendarKey(RECORTE_TZ, yyyyMmDd),
  }
}

function calendarKeyNowSp() {
  return calendarKeyInTz(new Date().toISOString(), RECORTE_TZ)
}

function calendarKeyWeekMondaySp() {
  let k = calendarKeyNowSp()
  for (let i = 0; i < 8; i++) {
    const wd = new Intl.DateTimeFormat('en-US', { timeZone: RECORTE_TZ, weekday: 'short' }).format(new Date(startIsoFromCalendarKey(RECORTE_TZ, k)))
    if (wd === 'Mon') return k
    k = addDaysToCalendarKey(k, -1)
  }
  return k
}

function calendarKeyMonthFirstFromKey(k) {
  const [y, m] = k.split('-')
  return `${y}-${m}-01`
}

function calendarKeyNextMonthFirstFromKey(k) {
  const [y, m] = k.split('-').map(Number)
  const nm = m >= 12 ? 1 : m + 1
  const ny = m >= 12 ? y + 1 : y
  return `${ny}-${String(nm).padStart(2, '0')}-01`
}

function parseDmyFromMatch(g1, g2, g3, defaultYear) {
  const dia = Math.min(31, Math.max(1, parseInt(g1, 10)))
  const mes = Math.min(12, Math.max(1, parseInt(g2, 10)))
  let ano = defaultYear
  if (g3) {
    const y = parseInt(g3, 10)
    ano = String(g3).length === 2 ? 2000 + y : y
  }
  return `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`
}

/**
 * Interpretação determinística de período na pergunta (fuso America/Sao_Paulo).
 * Sobrepõe janelas padrão (7/90 dias) quando o administrador pede dia/semana/mês explícitos.
 */
function resolveTemporalAnalyticsScope(question, cls) {
  const qRaw = String(question || '').trim()
  if (!qRaw) return null
  const q = qRaw.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
  const anoRef = new Date().getFullYear()

  const range = qRaw.match(/\bentre\s+(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\s+e\s+(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/i)
    || qRaw.match(/\bde\s+(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\s+ate\s+(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/i)
  if (range) {
    const k0 = parseDmyFromMatch(range[1], range[2], range[3], anoRef)
    const k1 = parseDmyFromMatch(range[4], range[5], range[6] || range[3], anoRef)
    const [first, last] = k0 <= k1 ? [k0, k1] : [k1, k0]
    const fimEx = endExclusiveIsoFromCalendarKey(RECORTE_TZ, last)
    const inicio = startIsoFromCalendarKey(RECORTE_TZ, first)
    if (inicio && fimEx) {
      return {
        fixado_na_pergunta: true,
        rotulo: `De ${calendarKeyToBRLabel(first)} a ${calendarKeyToBRLabel(last)} (${RECORTE_TZ})`,
        opts: {
          periodo_mensagens_inicio_iso: inicio,
          periodo_mensagens_fim_exclusive_iso: fimEx,
          periodo_consulta_rotulo: `De ${calendarKeyToBRLabel(first)} a ${calendarKeyToBRLabel(last)}`,
          impedir_fallback_mensagens_antigas: true,
          periodo_fixado_na_pergunta: true,
        },
      }
    }
  }

  if (/\bhoje\b/.test(q) || /\bagora\b/.test(q) || /\bneste dia\b/.test(q)) {
    const k = calendarKeyNowSp()
    const fim = endExclusiveIsoFromCalendarKey(RECORTE_TZ, k)
    const inicio = startIsoFromCalendarKey(RECORTE_TZ, k)
    return {
      fixado_na_pergunta: true,
      rotulo: `Hoje (${calendarKeyToBRLabel(k)}, ${RECORTE_TZ})`,
      opts: {
        periodo_mensagens_inicio_iso: inicio,
        periodo_mensagens_fim_exclusive_iso: fim,
        periodo_consulta_rotulo: `Hoje (${calendarKeyToBRLabel(k)})`,
        impedir_fallback_mensagens_antigas: true,
        periodo_fixado_na_pergunta: true,
      },
    }
  }

  if (/\bontem\b/.test(q)) {
    const k = addDaysToCalendarKey(calendarKeyNowSp(), -1)
    const fim = endExclusiveIsoFromCalendarKey(RECORTE_TZ, k)
    const inicio = startIsoFromCalendarKey(RECORTE_TZ, k)
    return {
      fixado_na_pergunta: true,
      rotulo: `Ontem (${calendarKeyToBRLabel(k)}, ${RECORTE_TZ})`,
      opts: {
        periodo_mensagens_inicio_iso: inicio,
        periodo_mensagens_fim_exclusive_iso: fim,
        periodo_consulta_rotulo: `Ontem (${calendarKeyToBRLabel(k)})`,
        impedir_fallback_mensagens_antigas: true,
        periodo_fixado_na_pergunta: true,
      },
    }
  }

  if (/\besta semana\b/.test(q) || /\bnesta semana\b/.test(q)) {
    const mon = calendarKeyWeekMondaySp()
    const today = calendarKeyNowSp()
    const fim = endExclusiveIsoFromCalendarKey(RECORTE_TZ, today)
    const inicio = startIsoFromCalendarKey(RECORTE_TZ, mon)
    return {
      fixado_na_pergunta: true,
      rotulo: `Semana corrente (${calendarKeyToBRLabel(mon)} a ${calendarKeyToBRLabel(today)}, ${RECORTE_TZ})`,
      opts: {
        periodo_mensagens_inicio_iso: inicio,
        periodo_mensagens_fim_exclusive_iso: fim,
        periodo_consulta_rotulo: 'Esta semana (segunda a hoje)',
        impedir_fallback_mensagens_antigas: true,
        periodo_fixado_na_pergunta: true,
      },
    }
  }

  if (/\beste mes\b/.test(q) || /\bneste mes\b/.test(q)) {
    const today = calendarKeyNowSp()
    const first = calendarKeyMonthFirstFromKey(today)
    const next = calendarKeyNextMonthFirstFromKey(first)
    const inicio = startIsoFromCalendarKey(RECORTE_TZ, first)
    const fim = startIsoFromCalendarKey(RECORTE_TZ, next)
    return {
      fixado_na_pergunta: true,
      rotulo: `Mês corrente (${calendarKeyToBRLabel(first)} a ${calendarKeyToBRLabel(today)}, ${RECORTE_TZ})`,
      opts: {
        periodo_mensagens_inicio_iso: inicio,
        periodo_mensagens_fim_exclusive_iso: fim,
        periodo_consulta_rotulo: 'Este mês',
        impedir_fallback_mensagens_antigas: true,
        periodo_fixado_na_pergunta: true,
      },
    }
  }

  const INTENTS_DIA_UNICO = new Set([
    'BUSCA_CONTEUDO_MENSAGENS',
    'MENSAGENS_USUARIO_CLIENTE',
    'CONVERSAS_USUARIO_CLIENTE',
    'HISTORICO_CLIENTE',
    'DETALHES_CONVERSA',
    'HISTORICO_ATENDENTE',
    'RELATORIO_ATENDENTE_COMPLETO',
    'ATENDENTE_MAIS_MENSAGENS_COM_TEMA',
    'SINAIS_INTERESSE_COMPRA',
    'CLIENTES_POR_TEMA_FINANCEIRO',
    'CONVERSAS_POR_ASSUNTO_OPERACIONAL',
    'ATENDIMENTOS_TRANSFERIDOS',
    'CLIENTES_MENSAGEM_SEM_RESPOSTA_ATENDENTE',
    'MENSAGENS_ENVIADAS_ATENDENTE_AUTOR',
    'RELATORIO_PRODUTIVIDADE_ATENDENTES',
  ])
  if (cls?.data_referencia_iso && INTENTS_DIA_UNICO.has(cls.intent)) {
    const b = dayBoundsSpForIsoDate(cls.data_referencia_iso)
    if (b?.inicio && b?.fim) {
      return {
        fixado_na_pergunta: true,
        rotulo: `Dia ${calendarKeyToBRLabel(cls.data_referencia_iso)} (${RECORTE_TZ})`,
        opts: {
          periodo_mensagens_inicio_iso: b.inicio,
          periodo_mensagens_fim_exclusive_iso: b.fim,
          periodo_consulta_rotulo: `Dia ${calendarKeyToBRLabel(cls.data_referencia_iso)}`,
          impedir_fallback_mensagens_antigas: true,
          periodo_fixado_na_pergunta: true,
        },
      }
    }
  }

  return null
}

function filtrarPorCriadoEm(list, inicioIso, fimExclusiveIso, campo = 'criado_em') {
  if (!inicioIso || !Array.isArray(list)) return list || []
  return list.filter((row) => {
    const ts = row?.[campo]
    if (!ts) return false
    if (ts < inicioIso) return false
    if (fimExclusiveIso && ts >= fimExclusiveIso) return false
    return true
  })
}

/** Metadados das datas reais das mensagens — evita "hoje" indevido no texto gerado. */
function buildRecorteTemporalMeta(mensagens, ctx) {
  const list = (mensagens || []).filter((m) => m && m.criado_em)
  if (!list.length) {
    const pi = ctx?.periodo_pedido_inicio_iso
    const pf = ctx?.periodo_pedido_fim_exclusive_iso
    if (pi && pf) {
      const minK = calendarKeyInTz(pi)
      const maxK = calendarKeyInTz(new Date(Date.parse(pf) - 1).toISOString())
      const todayKey = calendarKeyNowSp()
      const pode = minK === maxK && minK === todayKey
      const rot = ctx?.rotulo_pedido || `${calendarKeyToBRLabel(minK)} a ${calendarKeyToBRLabel(maxK)}`
      return {
        fuso: RECORTE_TZ,
        primeiro_criado_em: pi,
        ultimo_criado_em: new Date(Date.parse(pf) - 1).toISOString(),
        primeiro_data_exibicao: formatDateTimeBR(pi),
        ultimo_data_exibicao: formatDateTimeBR(new Date(Date.parse(pf) - 1).toISOString()),
        primeiro_dia_calendario: minK,
        ultimo_dia_calendario: maxK,
        dias_distintos_calendario: minK === maxK ? 1 : 2,
        pode_usar_hoje_no_texto: pode,
        janela_consulta_dias: ctx?.periodo_dias ?? null,
        periodo_definido_na_requisicao: ctx?.periodo_explicito === true,
        sem_mensagens_no_periodo: true,
        instrucao_temporal_obrigatoria: `Nenhuma mensagem foi retornada para o período solicitado (${rot}, ${RECORTE_TZ}). Não invente diálogo nem use "hoje" se não for o dia civil atual desse recorte. Diga claramente que não há mensagens nesse intervalo.`,
        texto_cabecalho_ui: `0 mensagens — período solicitado: ${rot} (${RECORTE_TZ})`,
      }
    }
    return null
  }
  let minIso = list[0].criado_em
  let maxIso = list[0].criado_em
  for (const m of list) {
    if (m.criado_em < minIso) minIso = m.criado_em
    if (m.criado_em > maxIso) maxIso = m.criado_em
  }
  const keys = [...new Set(list.map((m) => calendarKeyInTz(m.criado_em)).filter(Boolean))].sort()
  const todayKey = calendarKeyNowSp()
  const minK = keys[0]
  const maxK = keys[keys.length - 1]
  const apenas_um_dia = minK === maxK
  const esse_dia_eh_hoje = minK === todayKey && maxK === todayKey
  const pode_usar_hoje = apenas_um_dia && esse_dia_eh_hoje
  const instrucao = pode_usar_hoje
    ? `Todas as mensagens em Dados.mensagens são do dia civil atual (${calendarKeyToBRLabel(todayKey)}, fuso ${RECORTE_TZ}). Pode usar "hoje" só se ficar explícito que se refere a essas mensagens; prefira citar a data (${calendarKeyToBRLabel(todayKey)}).`
    : `Datas reais das mensagens retornadas: de ${calendarKeyToBRLabel(minK)} a ${calendarKeyToBRLabel(maxK)} (fuso ${RECORTE_TZ}). É PROIBIDO usar "hoje", "ontem" ou "nesta conversa de hoje" para esse conjunto — use "nas mensagens retornadas", "no período analisado" ou cite ${calendarKeyToBRLabel(minK)}${minK !== maxK ? ` a ${calendarKeyToBRLabel(maxK)}` : ''}.`

  return {
    fuso: RECORTE_TZ,
    primeiro_criado_em: minIso,
    ultimo_criado_em: maxIso,
    primeiro_data_exibicao: formatDateTimeBR(minIso),
    ultimo_data_exibicao: formatDateTimeBR(maxIso),
    primeiro_dia_calendario: minK,
    ultimo_dia_calendario: maxK,
    dias_distintos_calendario: keys.length,
    pode_usar_hoje_no_texto: pode_usar_hoje,
    janela_consulta_dias: ctx?.periodo_dias ?? null,
    periodo_definido_na_requisicao: ctx?.periodo_explicito === true,
    instrucao_temporal_obrigatoria: instrucao,
    texto_cabecalho_ui: `Análise de ${list.length} mensagem(ns) — ${formatDateTimeBR(minIso)} → ${formatDateTimeBR(maxIso)} (${RECORTE_TZ})`,
  }
}

/** Limites de dia UTC para data_referencia_iso (YYYY-MM-DD). */
function dayBoundsUtc(isoDate) {
  if (!isoDate || typeof isoDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return null
  const start = new Date(`${isoDate}T00:00:00.000Z`)
  if (Number.isNaN(start.getTime())) return null
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000)
  return { inicio: start.toISOString(), fim: end.toISOString() }
}

function questionHasExplicitDateRange(question) {
  const qRaw = String(question || '').trim()
  if (!qRaw) return false
  const q = qRaw.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
  return /\bentre\s+\d{1,2}[\/\-]\d{1,2}/.test(q)
    || /\bde\s+\d{1,2}[\/\-]\d{1,2}\s+ate\s+\d{1,2}[\/\-]\d{1,2}/.test(q)
}

function enrichDataReferenciaFromQuestion(cls, question) {
  if (!question || typeof question !== 'string') return cls
  if (questionHasExplicitDateRange(question)) return cls
  const intentsComData = new Set([
    'BUSCA_CONTEUDO_MENSAGENS',
    'SINAIS_INTERESSE_COMPRA',
    'CLIENTES_POR_TEMA_FINANCEIRO',
    'CONVERSAS_POR_ASSUNTO_OPERACIONAL',
    'CHAT_INTERNO_POR_TEMA',
    'ATENDENTE_MAIS_MENSAGENS_COM_TEMA',
    'RANKING_EDUCACAO_ATENDENTES',
    'MENSAGENS_USUARIO_CLIENTE',
    'CONVERSAS_USUARIO_CLIENTE',
    'HISTORICO_CLIENTE',
    'DETALHES_CONVERSA',
    'HISTORICO_ATENDENTE',
    'RELATORIO_ATENDENTE_COMPLETO',
    'ATENDIMENTOS_TRANSFERIDOS',
    'CLIENTES_MENSAGEM_SEM_RESPOSTA_ATENDENTE',
    'MENSAGENS_ENVIADAS_ATENDENTE_AUTOR',
    'RELATORIO_PRODUTIVIDADE_ATENDENTES',
  ])
  if (!intentsComData.has(cls.intent) || cls.data_referencia_iso) return cls
  const m = question.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{4}|\d{2}))?\b/)
  if (!m) return cls
  const dia = Math.min(31, Math.max(1, parseInt(m[1], 10)))
  const mes = Math.min(12, Math.max(1, parseInt(m[2], 10)))
  let ano = new Date().getFullYear()
  if (m[3]) {
    const y = parseInt(m[3], 10)
    ano = m[3].length === 2 ? 2000 + y : y
  }
  const iso = `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`
  return { ...cls, data_referencia_iso: iso }
}

module.exports = {
  RECORTE_TZ,
  calendarKeyInTz,
  formatDateTimeBR,
  calendarKeyToBRLabel,
  startOfZonedDayUtcMs,
  startIsoFromCalendarKey,
  addDaysToCalendarKey,
  endExclusiveIsoFromCalendarKey,
  dayBoundsSpForIsoDate,
  calendarKeyNowSp,
  calendarKeyWeekMondaySp,
  calendarKeyMonthFirstFromKey,
  calendarKeyNextMonthFirstFromKey,
  parseDmyFromMatch,
  resolveTemporalAnalyticsScope,
  filtrarPorCriadoEm,
  buildRecorteTemporalMeta,
  dayBoundsUtc,
  questionHasExplicitDateRange,
  enrichDataReferenciaFromQuestion,
}
