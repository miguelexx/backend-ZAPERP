/**
 * Derivação pura dos filtros/flags de GET /chats (listarConversas) a partir de req.query.
 *
 * Extraído de controllers/chatController.js (Fase 4 da modularização) sem alteração de comportamento.
 * Apenas parsing/normalização síncrona — nenhuma query, req/res ou efeito colateral. As queries SQL,
 * closures (sendEmptyChatListResponse/loadColaboradoresEncaminhar) e awaits permanecem no handler.
 *
 * Regras preservadas:
 * - Com termo de busca (`palavra`), os filtros de estado/aba são ignorados (searchBypassesStateFilters),
 *   mas filtros avançados explícitos (tag, setor, datas, atendente_id) continuam valendo no handler.
 * - `atendente_id` deve ser inteiro positivo (usuarios.id); UUID/texto → `atendenteIdInvalido: true`
 *   (o handler responde 400).
 */

const TEMPO_PARADO_HORAS = {
  '2h': 2,
  '12h': 12,
  '24h': 24,
  '7d': 24 * 7,
  '30d': 24 * 30,
}

const isTruthyFlag = (v) => v === '1' || v === 'true' || v === 1 || v === true

function deriveListarConversasFilters(query = {}) {
  const {
    tag_id,
    status_atendimento,
    atendente_id,
    palavra,
    incluir_todos_clientes: incluirTodosClientes,
    minha_fila: minhaFilaRaw,
    incluir_colaboradores_encaminhar: incluirColabEncRaw,
    aguardando_cliente: aguardandoClienteRaw,
    aguardando_atendente: aguardandoAtendenteRaw,
    pagamento_pendente: pagamentoPendenteRaw,
    em_atraso: emAtrasoRaw,
    tempo_parado: tempoParadoRaw,
    finalizacao_motivo: finalizacaoMotivoRaw,
    hoje: hojeRaw,
    campanhas: campanhasRaw,
  } = query

  const filtroAusenciaListaRaw =
    String(finalizacaoMotivoRaw ?? '')
      .trim()
      .toLowerCase() === 'ausencia_cliente'

  const tempoParadoKey =
    tempoParadoRaw != null && String(tempoParadoRaw).trim() !== ''
      ? String(tempoParadoRaw).trim().toLowerCase()
      : null
  const tempoParadoHorasRaw =
    tempoParadoKey && Object.prototype.hasOwnProperty.call(TEMPO_PARADO_HORAS, tempoParadoKey)
      ? TEMPO_PARADO_HORAS[tempoParadoKey]
      : null

  const aguardandoClienteRawAtivo = isTruthyFlag(aguardandoClienteRaw)
  const aguardandoAtendenteRawAtivo = isTruthyFlag(aguardandoAtendenteRaw)
  const pagamentoPendenteRawAtivo = isTruthyFlag(pagamentoPendenteRaw)
  const emAtrasoRawAtivo = isTruthyFlag(emAtrasoRaw)
  const hojeRawAtivo = isTruthyFlag(hojeRaw)
  const minhaFilaRawAtiva = isTruthyFlag(minhaFilaRaw)
  const campanhasRawAtiva = isTruthyFlag(campanhasRaw)

  const tagFilterAtivo =
    tag_id != null &&
    String(tag_id).trim() !== '' &&
    String(tag_id).trim().toLowerCase() !== 'todas'

  const incluirColaboradoresEncaminhar = isTruthyFlag(incluirColabEncRaw)

  const incluirTodosClientesAtivo = isTruthyFlag(incluirTodosClientes)

  const palavraTrim = palavra && String(palavra).trim() ? String(palavra).trim() : ''
  // B01: com termo de busca, não restringir por aba/chip de estado (comportamento tipo WhatsApp).
  // Mantém filtros avançados explícitos (tag, setor, datas, atendente_id).
  const searchBypassesStateFilters = Boolean(palavraTrim)

  const aguardandoClienteAtivo = searchBypassesStateFilters ? false : aguardandoClienteRawAtivo
  const aguardandoAtendenteAtivo = searchBypassesStateFilters ? false : aguardandoAtendenteRawAtivo
  const pagamentoPendenteAtivo = searchBypassesStateFilters ? false : pagamentoPendenteRawAtivo
  const emAtrasoAtivo = searchBypassesStateFilters ? false : emAtrasoRawAtivo
  const hojeAtivo = searchBypassesStateFilters ? false : hojeRawAtivo
  const minhaFilaAtiva = searchBypassesStateFilters ? false : minhaFilaRawAtiva
  const campanhasAtiva = searchBypassesStateFilters ? false : campanhasRawAtiva
  const tempoParadoHoras = searchBypassesStateFilters ? null : tempoParadoHorasRaw
  const filtroAusenciaLista = searchBypassesStateFilters ? false : filtroAusenciaListaRaw

  const statusNorm =
    searchBypassesStateFilters
      ? null
      : !minhaFilaAtiva &&
          !campanhasAtiva &&
          !pagamentoPendenteAtivo &&
          !emAtrasoAtivo &&
          !hojeAtivo &&
          status_atendimento != null &&
          String(status_atendimento).trim() !== ''
        ? String(status_atendimento).toLowerCase().trim()
        : null

  /** Inteiro positivo (usuarios.id). UUID não é coluna de atendente_id na conversa — rejeitar valores não inteiros. */
  let filtroAtendenteInformado = null
  let atendenteIdInvalido = false
  if (atendente_id != null && String(atendente_id).trim() !== '') {
    const trimmed = String(atendente_id).trim()
    const num = Number(trimmed)
    if (!Number.isInteger(num) || num <= 0) {
      atendenteIdInvalido = true
    } else {
      filtroAtendenteInformado = num
    }
  }

  return {
    tagFilterAtivo,
    incluirColaboradoresEncaminhar,
    incluirTodosClientesAtivo,
    palavraTrim,
    searchBypassesStateFilters,
    aguardandoClienteAtivo,
    aguardandoAtendenteAtivo,
    pagamentoPendenteAtivo,
    emAtrasoAtivo,
    hojeAtivo,
    minhaFilaAtiva,
    campanhasAtiva,
    tempoParadoHoras,
    filtroAusenciaLista,
    statusNorm,
    filtroAtendenteInformado,
    atendenteIdInvalido,
  }
}

module.exports = { deriveListarConversasFilters, TEMPO_PARADO_HORAS }
