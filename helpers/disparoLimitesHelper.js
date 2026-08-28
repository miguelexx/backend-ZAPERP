/**
 * Regras de limites, janelas, fuso, agendamento e simulação — Etapa 5 Disparo.
 * Sem envio real. Usa luxon para fuso horário.
 */

const { DateTime, Interval } = require('luxon')

/** Limites técnicos de segurança (provedor / operação). */
const LIMITES_TECNICOS = {
  INTERVALO_MIN_ABS: 1,
  INTERVALO_MAX_ABS: 7200,
  LIMITE_HORA_MAX: 1000,
  LIMITE_DIA_MAX: 20000,
  LOTE_MAX: 500,
  PAUSA_LOTE_MAX: 86400,
  /** Intervalo mínimo recomendado UltraMSG / anti-bloqueio (não burlar). */
  INTERVALO_MIN_PROVEDOR: Number(process.env.DISPARO_INTERVALO_MIN_PROVEDOR_SEC || 3),
  LIMITE_HORA_PROVEDOR: Number(process.env.DISPARO_LIMITE_HORA_PROVEDOR || 200),
  LIMITE_DIA_PROVEDOR: Number(process.env.DISPARO_LIMITE_DIA_PROVEDOR || 2000),
}

const PERFIS = {
  conservador: {
    limite_por_hora: 30,
    limite_por_dia: 200,
    intervalo_min_sec: 15,
    intervalo_max_sec: 45,
    lote_tamanho: 10,
    pausa_lote_min_sec: 120,
    pausa_lote_max_sec: 300,
  },
  moderado: {
    limite_por_hora: 60,
    limite_por_dia: 500,
    intervalo_min_sec: 8,
    intervalo_max_sec: 20,
    lote_tamanho: 20,
    pausa_lote_min_sec: 60,
    pausa_lote_max_sec: 180,
  },
}

const FUSO_PADRAO = 'America/Sao_Paulo'
const DIAS_LABEL = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado']

function fusoValido(tz) {
  try {
    return Boolean(DateTime.now().setZone(tz).isValid)
  } catch {
    return false
  }
}

function parseTimeToMinutes(t) {
  if (t == null) return null
  if (typeof t === 'number') return t
  const s = String(t).slice(0, 8)
  const [hh, mm, ss] = s.split(':').map(Number)
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null
  return hh * 60 + mm + (Number.isFinite(ss) ? ss / 60 : 0)
}

function minutesToTime(m) {
  const total = Math.floor(m)
  const hh = String(Math.floor(total / 60)).padStart(2, '0')
  const mm = String(total % 60).padStart(2, '0')
  return `${hh}:${mm}:00`
}

/**
 * Detecta sobreposição entre janelas do mesmo dia.
 * @param {Array<{dia_semana:number, hora_inicio:string, hora_fim:string, ativo?:boolean}>} janelas
 */
function detectarSobreposicoes(janelas) {
  const erros = []
  const ativos = (janelas || []).filter((j) => j.ativo !== false)
  const byDay = new Map()
  for (const j of ativos) {
    const d = Number(j.dia_semana)
    if (!byDay.has(d)) byDay.set(d, [])
    byDay.get(d).push(j)
  }
  for (const [dia, list] of byDay) {
    const ranges = list
      .map((j) => ({
        start: parseTimeToMinutes(j.hora_inicio),
        end: parseTimeToMinutes(j.hora_fim),
        raw: j,
      }))
      .filter((r) => r.start != null && r.end != null && r.start < r.end)
      .sort((a, b) => a.start - b.start)

    for (let i = 1; i < ranges.length; i++) {
      if (ranges[i].start < ranges[i - 1].end) {
        erros.push(
          `Horários sobrepostos em ${DIAS_LABEL[dia] || dia}: ` +
          `${minutesToTime(ranges[i - 1].start).slice(0, 5)}–${minutesToTime(ranges[i - 1].end).slice(0, 5)} ` +
          `e ${minutesToTime(ranges[i].start).slice(0, 5)}–${minutesToTime(ranges[i].end).slice(0, 5)}.`,
        )
      }
    }
  }
  return erros
}

/**
 * Valida payload global de limites.
 * @returns {{ ok: boolean, erros: string[], avisos: string[], cleaned: object }}
 */
function validarLimitesGlobais(body = {}) {
  const erros = []
  const avisos = []
  const perfil = ['conservador', 'moderado', 'personalizado'].includes(body.perfil)
    ? body.perfil
    : 'personalizado'

  const num = (v, def) => {
    if (v === undefined || v === null || v === '') return def
    const n = Number(v)
    return Number.isFinite(n) ? n : def
  }

  const cleaned = {
    perfil,
    limite_total: body.limite_total == null || body.limite_total === ''
      ? null
      : Math.floor(num(body.limite_total, null)),
    limite_por_hora: Math.floor(num(body.limite_por_hora, 60)),
    limite_por_dia: Math.floor(num(body.limite_por_dia, 500)),
    intervalo_min_sec: Math.floor(num(body.intervalo_min_sec, 8)),
    intervalo_max_sec: Math.floor(num(body.intervalo_max_sec, 20)),
    lote_tamanho: Math.floor(num(body.lote_tamanho, 20)),
    pausa_lote_min_sec: Math.floor(num(body.pausa_lote_min_sec, 60)),
    pausa_lote_max_sec: Math.floor(num(body.pausa_lote_max_sec, 180)),
    fuso_horario: String(body.fuso_horario || FUSO_PADRAO).trim() || FUSO_PADRAO,
    inicio_modo: body.inicio_modo === 'agendado' ? 'agendado' : 'imediato',
    agendado_para: body.agendado_para || null,
    data_limite: body.data_limite || null,
    pausa_auto_desconexao: body.pausa_auto_desconexao !== false,
    pausa_auto_erros_consecutivos: Math.floor(num(body.pausa_auto_erros_consecutivos, 5)),
    pausa_auto_taxa_falha_pct: Number(num(body.pausa_auto_taxa_falha_pct, 25).toFixed(2)),
  }

  if (cleaned.limite_total != null && cleaned.limite_total <= 0) {
    erros.push('Limite total deve ser positivo ou nulo.')
  }
  if (cleaned.limite_por_hora <= 0) erros.push('Limite por hora deve ser maior que zero.')
  if (cleaned.limite_por_dia <= 0) erros.push('Limite por dia deve ser maior que zero.')
  if (cleaned.intervalo_min_sec <= 0) erros.push('Intervalo mínimo inválido.')
  if (cleaned.intervalo_max_sec <= 0) erros.push('Intervalo máximo inválido.')
  if (cleaned.intervalo_min_sec > cleaned.intervalo_max_sec) {
    erros.push('Intervalo mínimo não pode ser maior que o máximo.')
  }
  if (cleaned.pausa_lote_min_sec > cleaned.pausa_lote_max_sec) {
    erros.push('Pausa mínima do lote não pode ser maior que a máxima.')
  }
  if (cleaned.lote_tamanho <= 0) erros.push('Tamanho do lote deve ser maior que zero.')
  if (!fusoValido(cleaned.fuso_horario)) {
    erros.push(`Fuso horário inválido: ${cleaned.fuso_horario}`)
  }

  if (cleaned.intervalo_min_sec < LIMITES_TECNICOS.INTERVALO_MIN_PROVEDOR) {
    erros.push(
      `Intervalo mínimo abaixo do limite técnico do provedor (${LIMITES_TECNICOS.INTERVALO_MIN_PROVEDOR}s).`,
    )
  }
  if (cleaned.limite_por_hora > LIMITES_TECNICOS.LIMITE_HORA_PROVEDOR) {
    erros.push(
      `Limite por hora excede o teto técnico do provedor (${LIMITES_TECNICOS.LIMITE_HORA_PROVEDOR}/h).`,
    )
  }
  if (cleaned.limite_por_dia > LIMITES_TECNICOS.LIMITE_DIA_PROVEDOR) {
    erros.push(
      `Limite por dia excede o teto técnico do provedor (${LIMITES_TECNICOS.LIMITE_DIA_PROVEDOR}/dia).`,
    )
  }
  if (cleaned.limite_por_hora > LIMITES_TECNICOS.LIMITE_HORA_MAX) {
    erros.push('Limite por hora acima do máximo absoluto do sistema.')
  }
  if (cleaned.limite_por_dia > LIMITES_TECNICOS.LIMITE_DIA_MAX) {
    erros.push('Limite por dia acima do máximo absoluto do sistema.')
  }

  // Capacidade teórica: com intervalo mínimo, cabe no limite/hora?
  const teoricoPorHora = Math.floor(3600 / cleaned.intervalo_min_sec)
  if (cleaned.limite_por_hora > teoricoPorHora) {
    avisos.push(
      `Com intervalo mínimo de ${cleaned.intervalo_min_sec}s, o máximo teórico é ~${teoricoPorHora}/h. ` +
      `O limite configurado (${cleaned.limite_por_hora}/h) pode não ser atingível.`,
    )
  }

  if (cleaned.inicio_modo === 'imediato') {
    cleaned.agendado_para = null
  } else if (!cleaned.agendado_para) {
    erros.push('Agendamento exige data e hora.')
  } else {
    const dt = DateTime.fromISO(String(cleaned.agendado_para), { zone: 'utc' })
    if (!dt.isValid) {
      erros.push('Data/hora de agendamento inválida.')
    } else if (dt < DateTime.utc().minus({ minutes: 1 })) {
      erros.push('Não é possível agendar no passado.')
    } else {
      cleaned.agendado_para = dt.toISO()
    }
  }

  if (cleaned.data_limite) {
    const lim = DateTime.fromISO(String(cleaned.data_limite), { zone: 'utc' })
    if (!lim.isValid) {
      erros.push('Data limite inválida.')
    } else {
      cleaned.data_limite = lim.toISO()
      if (cleaned.agendado_para) {
        const ag = DateTime.fromISO(cleaned.agendado_para, { zone: 'utc' })
        if (lim <= ag) erros.push('Data limite deve ser posterior ao agendamento.')
      }
    }
  }

  if (cleaned.pausa_auto_erros_consecutivos < 1 || cleaned.pausa_auto_erros_consecutivos > 100) {
    erros.push('Erros consecutivos para pausa automática devem estar entre 1 e 100.')
  }
  if (cleaned.pausa_auto_taxa_falha_pct <= 0 || cleaned.pausa_auto_taxa_falha_pct > 100) {
    erros.push('Taxa de falha para pausa automática deve estar entre 0 e 100%.')
  }

  return { ok: erros.length === 0, erros, avisos, cleaned }
}

/**
 * Valida override por instância.
 */
function validarLimitesInstancia(body = {}, globalLimites = {}) {
  const erros = []
  const avisos = []
  const herdar = body.herdar_global !== false

  const cleaned = {
    herdar_global: herdar,
    janelas_proprias: body.janelas_proprias === true,
    limite_por_hora: null,
    limite_por_dia: null,
    intervalo_min_sec: null,
    intervalo_max_sec: null,
    lote_tamanho: null,
    pausa_lote_min_sec: null,
    pausa_lote_max_sec: null,
  }

  if (herdar) return { ok: true, erros, avisos, cleaned }

  const pick = (key) => (body[key] === undefined || body[key] === null || body[key] === ''
    ? null
    : Math.floor(Number(body[key])))

  cleaned.limite_por_hora = pick('limite_por_hora')
  cleaned.limite_por_dia = pick('limite_por_dia')
  cleaned.intervalo_min_sec = pick('intervalo_min_sec')
  cleaned.intervalo_max_sec = pick('intervalo_max_sec')
  cleaned.lote_tamanho = pick('lote_tamanho')
  cleaned.pausa_lote_min_sec = pick('pausa_lote_min_sec')
  cleaned.pausa_lote_max_sec = pick('pausa_lote_max_sec')

  const effective = {
    limite_por_hora: cleaned.limite_por_hora ?? globalLimites.limite_por_hora,
    limite_por_dia: cleaned.limite_por_dia ?? globalLimites.limite_por_dia,
    intervalo_min_sec: cleaned.intervalo_min_sec ?? globalLimites.intervalo_min_sec,
    intervalo_max_sec: cleaned.intervalo_max_sec ?? globalLimites.intervalo_max_sec,
  }

  if (cleaned.intervalo_min_sec != null && cleaned.intervalo_max_sec != null
    && cleaned.intervalo_min_sec > cleaned.intervalo_max_sec) {
    erros.push('Intervalo mínimo da instância maior que o máximo.')
  }
  if (cleaned.pausa_lote_min_sec != null && cleaned.pausa_lote_max_sec != null
    && cleaned.pausa_lote_min_sec > cleaned.pausa_lote_max_sec) {
    erros.push('Pausa mínima da instância maior que a máxima.')
  }
  if (effective.intervalo_min_sec < LIMITES_TECNICOS.INTERVALO_MIN_PROVEDOR) {
    erros.push(`Intervalo mínimo da instância abaixo do limite do provedor (${LIMITES_TECNICOS.INTERVALO_MIN_PROVEDOR}s).`)
  }
  if (effective.limite_por_hora > LIMITES_TECNICOS.LIMITE_HORA_PROVEDOR) {
    erros.push(`Limite/hora da instância excede o teto do provedor (${LIMITES_TECNICOS.LIMITE_HORA_PROVEDOR}).`)
  }
  if (effective.limite_por_dia > LIMITES_TECNICOS.LIMITE_DIA_PROVEDOR) {
    erros.push(`Limite/dia da instância excede o teto do provedor (${LIMITES_TECNICOS.LIMITE_DIA_PROVEDOR}).`)
  }

  return { ok: erros.length === 0, erros, avisos, cleaned, effective }
}

/**
 * Valida lista de janelas.
 */
function validarJanelas(janelas) {
  const erros = []
  const avisos = []
  const cleaned = []

  if (!Array.isArray(janelas) || !janelas.length) {
    erros.push('Configure ao menos uma janela de horário ativa.')
    return { ok: false, erros, avisos, cleaned }
  }

  for (const j of janelas) {
    const dia = Number(j.dia_semana)
    if (!Number.isInteger(dia) || dia < 0 || dia > 6) {
      erros.push(`Dia da semana inválido: ${j.dia_semana}`)
      continue
    }
    const start = parseTimeToMinutes(j.hora_inicio)
    const end = parseTimeToMinutes(j.hora_fim)
    if (start == null || end == null) {
      erros.push(`Horário inválido no dia ${DIAS_LABEL[dia]}.`)
      continue
    }
    if (start >= end) {
      erros.push(`Início deve ser anterior ao fim em ${DIAS_LABEL[dia]}.`)
      continue
    }
    cleaned.push({
      dia_semana: dia,
      hora_inicio: minutesToTime(start),
      hora_fim: minutesToTime(end),
      ativo: j.ativo !== false,
      instancia_id: j.instancia_id != null ? Number(j.instancia_id) : null,
    })
  }

  erros.push(...detectarSobreposicoes(cleaned))

  const ativos = cleaned.filter((j) => j.ativo)
  if (!ativos.length) erros.push('É necessário ao menos um período ativo para envio.')

  return { ok: erros.length === 0, erros, avisos, cleaned }
}

/**
 * Próximo instante válido dentro das janelas (no fuso da campanha).
 * @param {DateTime} fromDt - luxon DateTime no fuso da campanha
 * @param {Array} janelas - janelas ativas globais
 */
function proximoHorarioPermitido(fromDt, janelas) {
  const ativos = (janelas || []).filter((j) => j.ativo !== false)
  if (!ativos.length) return null

  let cursor = fromDt
  for (let dayOffset = 0; dayOffset < 14; dayOffset++) {
    const day = cursor.plus({ days: dayOffset }).startOf('day')
    const weekday = day.weekday % 7 // luxon: 1=Mon…7=Sun → JS 0=Sun…6=Sat: weekday%7 works (7→0)
    const ofDay = ativos
      .filter((j) => Number(j.dia_semana) === weekday)
      .map((j) => ({
        start: parseTimeToMinutes(j.hora_inicio),
        end: parseTimeToMinutes(j.hora_fim),
      }))
      .filter((r) => r.start != null && r.end != null)
      .sort((a, b) => a.start - b.start)

    for (const r of ofDay) {
      const startDt = day.plus({ minutes: r.start })
      const endDt = day.plus({ minutes: r.end })
      if (dayOffset === 0) {
        if (cursor < endDt) {
          return cursor < startDt ? startDt : cursor
        }
      } else if (startDt < endDt) {
        return startDt
      }
    }
  }
  return null
}

/**
 * Verifica se um instante está dentro de alguma janela.
 */
function estaNaJanela(dt, janelas) {
  const weekday = dt.weekday % 7
  const mins = dt.hour * 60 + dt.minute + dt.second / 60
  return (janelas || []).some((j) => {
    if (j.ativo === false) return false
    if (Number(j.dia_semana) !== weekday) return false
    const s = parseTimeToMinutes(j.hora_inicio)
    const e = parseTimeToMinutes(j.hora_fim)
    return s != null && e != null && mins >= s && mins < e
  })
}

/**
 * Efetiva config de uma instância (merge com global).
 */
function sanitizarIntervalosConfig(cfg) {
  const floor = Math.max(1, Number(LIMITES_TECNICOS.INTERVALO_MIN_PROVEDOR) || 3)
  const minRaw = Number(cfg.intervalo_min_sec)
  const maxRaw = Number(cfg.intervalo_max_sec)
  const min = Math.max(floor, Number.isFinite(minRaw) && minRaw > 0 ? minRaw : floor)
  const max = Math.max(min, Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : min)
  return { ...cfg, intervalo_min_sec: min, intervalo_max_sec: max }
}

function efetivarConfigInstancia(globalCfg, instOverride) {
  if (!instOverride || instOverride.herdar_global !== false) {
    return sanitizarIntervalosConfig({
      herdar_global: true,
      limite_por_hora: globalCfg.limite_por_hora,
      limite_por_dia: globalCfg.limite_por_dia,
      intervalo_min_sec: globalCfg.intervalo_min_sec,
      intervalo_max_sec: globalCfg.intervalo_max_sec,
      lote_tamanho: globalCfg.lote_tamanho,
      pausa_lote_min_sec: globalCfg.pausa_lote_min_sec,
      pausa_lote_max_sec: globalCfg.pausa_lote_max_sec,
      janelas_proprias: false,
    })
  }
  return sanitizarIntervalosConfig({
    herdar_global: false,
    limite_por_hora: instOverride.limite_por_hora ?? globalCfg.limite_por_hora,
    limite_por_dia: instOverride.limite_por_dia ?? globalCfg.limite_por_dia,
    intervalo_min_sec: instOverride.intervalo_min_sec ?? globalCfg.intervalo_min_sec,
    intervalo_max_sec: instOverride.intervalo_max_sec ?? globalCfg.intervalo_max_sec,
    lote_tamanho: instOverride.lote_tamanho ?? globalCfg.lote_tamanho,
    pausa_lote_min_sec: instOverride.pausa_lote_min_sec ?? globalCfg.pausa_lote_min_sec,
    pausa_lote_max_sec: instOverride.pausa_lote_max_sec ?? globalCfg.pausa_lote_max_sec,
    janelas_proprias: instOverride.janelas_proprias === true,
  })
}

function intervaloEnvioSec(cfg, random = Math.random) {
  const min = Number(cfg.intervalo_min_sec)
  const max = Number(cfg.intervalo_max_sec)
  if (!Number.isFinite(min) || min <= 0) return LIMITES_TECNICOS.INTERVALO_MIN_PROVEDOR
  if (!Number.isFinite(max) || max <= min) return min
  const u = typeof random === 'function' ? Number(random()) : 0
  const ratio = Number.isFinite(u) ? Math.min(1, Math.max(0, u)) : 0
  return min + (max - min) * ratio
}

/**
 * Gera timestamps UTC (ISO) para N envios de uma instância, respeitando
 * intervalo min/max, pausa de lote, limite hora/dia e janelas semanais.
 */
function gerarHorariosDisparo({
  quantidade,
  globalCfg,
  override = null,
  janelas = [],
  inicioDt,
  random = Math.random,
} = {}) {
  const cfg = efetivarConfigInstancia(globalCfg || PERFIS.moderado, override)
  const qty = Math.max(0, Math.floor(Number(quantidade) || 0))
  const horarios = []
  if (!qty || !inicioDt || !inicioDt.isValid) return horarios

  const janelasAtivas = (janelas || []).filter((j) => j.ativo !== false)
  const lote = Math.max(1, Number(cfg.lote_tamanho) || 1)
  const pausaLoteMin = Number(cfg.pausa_lote_min_sec) || 0
  const pausaLoteMax = Math.max(pausaLoteMin, Number(cfg.pausa_lote_max_sec) || pausaLoteMin)
  const pausaLoteMedia = (pausaLoteMin + pausaLoteMax) / 2

  let cursor = inicioDt
  if (janelasAtivas.length && !estaNaJanela(cursor, janelasAtivas)) {
    const p = proximoHorarioPermitido(cursor, janelasAtivas)
    if (p) cursor = p
  }

  let enviados = 0
  let enviadosNoDia = 0
  let enviadosNaHora = 0
  let horaJanelaInicio = cursor
  let diaAtual = cursor.toISODate()
  const maxSteps = qty * 50 + 10000
  let steps = 0

  while (enviados < qty && steps < maxSteps) {
    steps += 1

    if (cursor.toISODate() !== diaAtual) {
      diaAtual = cursor.toISODate()
      enviadosNoDia = 0
    }
    if (cursor.diff(horaJanelaInicio, 'minutes').minutes >= 60) {
      horaJanelaInicio = cursor
      enviadosNaHora = 0
    }

    if (janelasAtivas.length && !estaNaJanela(cursor, janelasAtivas)) {
      const p = proximoHorarioPermitido(cursor, janelasAtivas)
      if (!p) break
      cursor = p
      enviadosNaHora = 0
      horaJanelaInicio = cursor
      if (cursor.toISODate() !== diaAtual) {
        diaAtual = cursor.toISODate()
        enviadosNoDia = 0
      }
      continue
    }

    if (enviadosNoDia >= cfg.limite_por_dia) {
      const amanha = cursor.plus({ days: 1 }).startOf('day')
      cursor = proximoHorarioPermitido(amanha, janelasAtivas) || amanha
      enviadosNoDia = 0
      enviadosNaHora = 0
      horaJanelaInicio = cursor
      diaAtual = cursor.toISODate()
      continue
    }

    if (enviadosNaHora >= cfg.limite_por_hora) {
      cursor = horaJanelaInicio.plus({ hours: 1 })
      if (janelasAtivas.length && !estaNaJanela(cursor, janelasAtivas)) {
        const p = proximoHorarioPermitido(cursor, janelasAtivas)
        if (p) cursor = p
      }
      enviadosNaHora = 0
      horaJanelaInicio = cursor
      continue
    }

    horarios.push(cursor.toUTC().toISO())
    enviados += 1
    enviadosNoDia += 1
    enviadosNaHora += 1

    cursor = cursor.plus({ seconds: intervaloEnvioSec(cfg, random) })
    if (enviados % lote === 0 && enviados < qty) {
      cursor = cursor.plus({ seconds: pausaLoteMedia })
    }
  }

  return horarios
}

/**
 * Simula duração do disparo por instância (sem enviar).
 * Regras:
 * - intervalo médio = (min+max)/2
 * - limite/hora = janela móvel 60 min (aproxima por ritmo)
 * - limite/dia no fuso
 * - pausa entre lotes
 * - respeita janelas semanais
 * Nenhum destinatário é “pulado” — apenas adiado.
 *
 * @param {object} opts
 */
function simularDuracao({
  destinatariosPorInstancia, // [{ instancia_id, nome, quantidade }]
  globalCfg,
  overridesByInst = {},
  janelasGlobais = [],
  janelasByInst = {},
  agoraIso = null,
}) {
  const avisos = [
    'Esta é uma estimativa. Desconexões, falhas e limites reais do provedor podem alterar a conclusão.',
    'Retentativas futuras serão contabilizadas na fila; nesta etapa não há envio real.',
  ]
  const erros = []
  const fuso = globalCfg.fuso_horario || FUSO_PADRAO

  let inicioBase
  if (globalCfg.inicio_modo === 'agendado' && globalCfg.agendado_para) {
    inicioBase = DateTime.fromISO(globalCfg.agendado_para, { zone: 'utc' }).setZone(fuso)
  } else {
    inicioBase = (agoraIso
      ? DateTime.fromISO(agoraIso, { zone: 'utc' })
      : DateTime.utc()
    ).setZone(fuso)
  }

  if (!inicioBase.isValid) {
    return { ok: false, erros: ['Data de início inválida para simulação.'], avisos, instancias: [], resumo: null }
  }

  // Ajusta início para dentro da janela
  const janelasInicio = janelasGlobais.filter((j) => j.ativo !== false && j.instancia_id == null)
  let inicioAjustado = inicioBase
  if (janelasInicio.length && !estaNaJanela(inicioBase, janelasInicio)) {
    const prox = proximoHorarioPermitido(inicioBase, janelasInicio)
    if (prox) {
      inicioAjustado = prox
      avisos.push(
        `Início previsto fora da janela. Próximo horário permitido: ${prox.toFormat('dd/LL/yyyy HH:mm')} (${fuso}).`,
      )
    } else {
      erros.push('Não há janela futura disponível para iniciar o envio.')
    }
  }

  const linhas = []
  let fimGlobal = inicioAjustado

  for (const inst of destinatariosPorInstancia || []) {
    const qty = Math.max(0, Number(inst.quantidade) || 0)
    const cfg = efetivarConfigInstancia(globalCfg, overridesByInst[inst.instancia_id])
    const janelas = cfg.janelas_proprias && janelasByInst[inst.instancia_id]?.length
      ? janelasByInst[inst.instancia_id]
      : janelasInicio

    if (!qty) {
      linhas.push({
        instancia_id: inst.instancia_id,
        nome: inst.nome,
        quantidade: 0,
        lotes: 0,
        inicio: inicioAjustado.toISO(),
        fim: inicioAjustado.toISO(),
        dias_utilizados: [],
        por_dia: [],
        pausas_previstas: 0,
        intervalo_medio_sec: (cfg.intervalo_min_sec + cfg.intervalo_max_sec) / 2,
        config: cfg,
      })
      continue
    }

    const intervaloMedio = (cfg.intervalo_min_sec + cfg.intervalo_max_sec) / 2
    const pausaLoteMedia = (cfg.pausa_lote_min_sec + cfg.pausa_lote_max_sec) / 2
    const lote = Math.max(1, cfg.lote_tamanho)
    const numLotes = Math.ceil(qty / lote)

    // Simulação segundo a segundo (avançando por mensagem)
    let cursor = inicioAjustado
    if (janelas.length && !estaNaJanela(cursor, janelas)) {
      const p = proximoHorarioPermitido(cursor, janelas)
      if (p) cursor = p
    }

    const porDiaMap = new Map()
    let enviados = 0
    let enviadosNoDia = 0
    let enviadosNaHora = 0
    let horaJanelaInicio = cursor
    let diaAtual = cursor.toISODate()
    let pausas = 0
    const maxSteps = qty * 50 + 10000 // safety

    let steps = 0
    while (enviados < qty && steps < maxSteps) {
      steps += 1

      // Virada de dia (fuso)
      if (cursor.toISODate() !== diaAtual) {
        diaAtual = cursor.toISODate()
        enviadosNoDia = 0
      }

      // Janela móvel de 60 min
      if (cursor.diff(horaJanelaInicio, 'minutes').minutes >= 60) {
        horaJanelaInicio = cursor
        enviadosNaHora = 0
      }

      // Fora da janela → pula para próxima
      if (janelas.length && !estaNaJanela(cursor, janelas)) {
        const p = proximoHorarioPermitido(cursor, janelas)
        if (!p) break
        cursor = p
        pausas += 1
        enviadosNaHora = 0
        horaJanelaInicio = cursor
        if (cursor.toISODate() !== diaAtual) {
          diaAtual = cursor.toISODate()
          enviadosNoDia = 0
        }
        continue
      }

      // Limite diário
      if (enviadosNoDia >= cfg.limite_por_dia) {
        const amanha = cursor.plus({ days: 1 }).startOf('day')
        const p = proximoHorarioPermitido(amanha, janelas) || amanha
        cursor = p
        pausas += 1
        enviadosNoDia = 0
        enviadosNaHora = 0
        horaJanelaInicio = cursor
        diaAtual = cursor.toISODate()
        continue
      }

      // Limite horário (janela móvel)
      if (enviadosNaHora >= cfg.limite_por_hora) {
        cursor = horaJanelaInicio.plus({ hours: 1 })
        if (janelas.length && !estaNaJanela(cursor, janelas)) {
          const p = proximoHorarioPermitido(cursor, janelas)
          if (p) cursor = p
        }
        pausas += 1
        enviadosNaHora = 0
        horaJanelaInicio = cursor
        continue
      }

      // "Envia" 1 mensagem
      enviados += 1
      enviadosNoDia += 1
      enviadosNaHora += 1
      const dKey = cursor.toISODate()
      porDiaMap.set(dKey, (porDiaMap.get(dKey) || 0) + 1)

      // Intervalo até a próxima
      cursor = cursor.plus({ seconds: intervaloMedio })

      // Pausa de lote
      if (enviados % lote === 0 && enviados < qty) {
        cursor = cursor.plus({ seconds: pausaLoteMedia })
        pausas += 1
      }
    }

    if (enviados < qty) {
      erros.push(
        `Instância "${inst.nome || inst.instancia_id}": simulação não conseguiu alocar todos os ${qty} destinatários (janelas/limites).`,
      )
    }

    const por_dia = [...porDiaMap.entries()].map(([dia, q]) => ({ dia, quantidade: q }))
    if (cursor > fimGlobal) fimGlobal = cursor

    linhas.push({
      instancia_id: inst.instancia_id,
      nome: inst.nome,
      quantidade: qty,
      quantidade_simulada: enviados,
      lotes: numLotes,
      inicio: inicioAjustado.toISO(),
      fim: cursor.toISO(),
      duracao_horas: +cursor.diff(inicioAjustado, 'hours').hours.toFixed(2),
      dias_utilizados: por_dia.map((p) => p.dia),
      por_dia,
      pausas_previstas: pausas,
      intervalo_medio_sec: intervaloMedio,
      pausa_lote_media_sec: pausaLoteMedia,
      config: cfg,
    })
  }

  const totalDest = (destinatariosPorInstancia || []).reduce((s, i) => s + (Number(i.quantidade) || 0), 0)
  const resumo = {
    total_destinatarios: totalDest,
    instancias: (destinatariosPorInstancia || []).length,
    inicio_previsto: inicioAjustado.toISO(),
    inicio_previsto_local: inicioAjustado.toFormat("dd/LL/yyyy HH:mm ' ('ZZZZ')'"),
    conclusao_aproximada: fimGlobal.toISO(),
    conclusao_aproximada_local: fimGlobal.toFormat("dd/LL/yyyy HH:mm ' ('ZZZZ')'"),
    duracao_total_horas: +fimGlobal.diff(inicioAjustado, 'hours').hours.toFixed(2),
    fuso_horario: fuso,
    disclaimer:
      'Previsão sujeita a mudanças por desconexões, falhas, retentativas e limites reais do provedor. Não há envio nesta etapa.',
  }

  // Capacidade zero?
  if (totalDest > 0 && !janelasInicio.length) {
    erros.push('Configuração sem janelas ativas — nenhum destinatário poderia ser enviado.')
  }

  return {
    ok: erros.length === 0,
    erros,
    avisos,
    instancias: linhas,
    resumo,
  }
}

/**
 * Documentação da regra de retentativa (ainda não implementada na fila):
 * Uma tentativa de reenvio DEVE ser contabilizada no limite horário/diário da instância
 * quando a fila futura existir. Nesta etapa apenas documentamos a regra.
 */
const REGRA_RETENTATIVA = {
  contabiliza_no_limite: true,
  implementada: false,
  descricao:
    'Cada tentativa de envio (incluindo reenvio) conta para limite_por_hora (janela móvel 60 min) e limite_por_dia (fuso da campanha). A fila futura não deve ignorar destinatários por limite — apenas aguardar a próxima janela/capacidade.',
}

module.exports = {
  LIMITES_TECNICOS,
  PERFIS,
  FUSO_PADRAO,
  DIAS_LABEL,
  fusoValido,
  parseTimeToMinutes,
  minutesToTime,
  detectarSobreposicoes,
  validarLimitesGlobais,
  validarLimitesInstancia,
  validarJanelas,
  proximoHorarioPermitido,
  estaNaJanela,
  efetivarConfigInstancia,
  sanitizarIntervalosConfig,
  intervaloEnvioSec,
  gerarHorariosDisparo,
  simularDuracao,
  REGRA_RETENTATIVA,
  DateTime,
  Interval,
}
