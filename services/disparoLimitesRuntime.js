/**
 * Regras de limites em tempo de execução — Etapa 7 Disparo.
 * Usado pelo worker para decidir se pode enviar agora ou aguardar.
 */

const {
  DateTime,
  estaNaJanela,
  proximoHorarioPermitido,
  efetivarConfigInstancia,
  FUSO_PADRAO,
} = require('../helpers/disparoLimitesHelper')

const STATUS_ENVIADOS = ['enviada', 'entregue', 'lida']

/**
 * Resolve janelas efetivas para uma instância (globais ou próprias).
 */
function resolverJanelasEfetivas(janelas, instanciaId, override) {
  const lista = janelas || []
  if (override?.janelas_proprias) {
    const proprias = lista.filter((j) => Number(j.instancia_id) === Number(instanciaId))
    if (proprias.length) return proprias
  }
  return lista.filter((j) => j.instancia_id == null)
}

/**
 * Próximo instante após limite diário (início do dia seguinte na janela).
 */
function proximoAposLimiteDiario(agora, janelasEfetivas) {
  const amanha = agora.plus({ days: 1 }).startOf('day')
  const prox = proximoHorarioPermitido(amanha, janelasEfetivas)
  return prox || amanha
}

/**
 * Próximo instante após janela móvel de 60 min (hora cheia a partir do início da janela).
 */
function proximoAposLimiteHorario(inicioJanelaHora, cfg) {
  const base = DateTime.fromISO(inicioJanelaHora, { zone: 'utc' })
  return base.plus({ hours: 1 })
}

/**
 * Verifica se o envio pode ocorrer agora respeitando limites e janelas.
 *
 * @returns {{ ok: boolean, motivo: string|null, tipo_espera: 'limite'|'horario'|null, proxima_tentativa_em: string|null }}
 */
function podeEnviarAgora({
  limites,
  janelas,
  instanciaId,
  override,
  agoraIso,
  ultimoEnvioIso,
  enviadosUltimaHora,
  enviadosHoje,
  loteAtualTamanho,
  loteConfig,
}) {
  if (!limites) {
    return {
      ok: false,
      motivo: 'Limites não configurados',
      tipo_espera: 'limite',
      proxima_tentativa_em: null,
    }
  }

  const cfg = efetivarConfigInstancia(limites, override)
  const fuso = limites.fuso_horario || FUSO_PADRAO
  const agora = agoraIso
    ? DateTime.fromISO(agoraIso, { zone: 'utc' }).setZone(fuso)
    : DateTime.now().setZone(fuso)

  const janelasEfetivas = resolverJanelasEfetivas(janelas, instanciaId, override)

  // Janela de horário / dia da semana
  if (janelasEfetivas.length && !estaNaJanela(agora, janelasEfetivas)) {
    const prox = proximoHorarioPermitido(agora, janelasEfetivas)
    return {
      ok: false,
      motivo: 'Fora da janela de horário permitida',
      tipo_espera: 'horario',
      proxima_tentativa_em: prox ? prox.toUTC().toISO() : null,
    }
  }

  // Pausa entre lotes (após completar um lote)
  if (
    loteConfig?.loteCompletoEm &&
    Number(loteAtualTamanho) >= Number(cfg.lote_tamanho)
  ) {
    const pausaSec = Number(loteConfig.pausaSec) ||
      Math.floor((cfg.pausa_lote_min_sec + cfg.pausa_lote_max_sec) / 2)
    const fimPausa = DateTime.fromISO(loteConfig.loteCompletoEm, { zone: 'utc' })
      .plus({ seconds: pausaSec })
    if (DateTime.utc() < fimPausa) {
      return {
        ok: false,
        motivo: 'Pausa entre lotes em andamento',
        tipo_espera: 'limite',
        proxima_tentativa_em: fimPausa.toISO(),
      }
    }
  }

  // Limite diário (fuso da campanha)
  const enviadosDia = Number(enviadosHoje) || 0
  if (enviadosDia >= cfg.limite_por_dia) {
    const prox = proximoAposLimiteDiario(agora, janelasEfetivas)
    return {
      ok: false,
      motivo: `Limite diário atingido (${enviadosDia}/${cfg.limite_por_dia})`,
      tipo_espera: 'limite',
      proxima_tentativa_em: prox.toUTC().toISO(),
    }
  }

  // Limite horário — janela móvel de 60 min
  const enviadosHora = Number(enviadosUltimaHora) || 0
  if (enviadosHora >= cfg.limite_por_hora) {
    const inicioJanela = loteConfig?.inicioJanelaHoraIso || ultimoEnvioIso || agora.toUTC().toISO()
    const prox = proximoAposLimiteHorario(inicioJanela, cfg)
    return {
      ok: false,
      motivo: `Limite por hora atingido (${enviadosHora}/${cfg.limite_por_hora})`,
      tipo_espera: 'limite',
      proxima_tentativa_em: prox.toISO(),
    }
  }

  // Intervalo mínimo desde o último envio
  if (ultimoEnvioIso) {
    const ultimo = DateTime.fromISO(ultimoEnvioIso, { zone: 'utc' })
    const diffSec = DateTime.utc().diff(ultimo, 'seconds').seconds
    if (diffSec < cfg.intervalo_min_sec) {
      const prox = ultimo.plus({ seconds: cfg.intervalo_min_sec })
      return {
        ok: false,
        motivo: `Intervalo mínimo entre envios (${cfg.intervalo_min_sec}s)`,
        tipo_espera: 'limite',
        proxima_tentativa_em: prox.toISO(),
      }
    }
  }

  return {
    ok: true,
    motivo: null,
    tipo_espera: null,
    proxima_tentativa_em: null,
  }
}

/**
 * Conta envios bem-sucedidos de uma instância desde um instante.
 */
async function contarEnviosJanela(supabase, { companyId, instanciaId, desdeIso }) {
  if (!supabase || !companyId || !instanciaId || !desdeIso) return 0

  const { count, error } = await supabase
    .from('disparo_fila_itens')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('instancia_id', instanciaId)
    .in('status', STATUS_ENVIADOS)
    .gte('enviado_em', desdeIso)

  if (error) throw error
  return count ?? 0
}

module.exports = {
  podeEnviarAgora,
  contarEnviosJanela,
  STATUS_ENVIADOS,
}
