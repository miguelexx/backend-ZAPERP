/**
 * Módulo "Separar mensagens disparadas" — classificação por TAMANHO (regras puras, sem I/O).
 *
 * Regra do produto: quando o módulo está ativo na empresa, toda mensagem de SAÍDA cujo
 * `texto.length > 600` deve ser tratada como "Mensagem Disparada" (status_atendimento =
 * 'mensagem_disparada') e ir para a aba "Mensagens Disparadas", não aparecendo em "Abertas".
 *
 * Guardas (decisão "Poupar atendimento ativo"):
 *  - só saída (`direcao === 'out'`);
 *  - só com o módulo ativo (`separarAtivo === true`);
 *  - só com `texto.length > 600` (600 ou menos = fluxo normal);
 *  - nunca em grupo;
 *  - nunca sobrepõe o módulo Disparo/Campanhas (`aguardando_resposta_campanha === true`);
 *  - preserva atendimento humano genuíno já em andamento (atendente atribuído, em_atendimento/
 *    aguardando_cliente, ou cliente já respondeu — histórico de inbound).
 *
 * Mensagens recebidas do cliente (`direcao === 'in'`) nunca são classificadas por esta regra.
 */

const LIMITE_TEXTO_MENSAGEM_DISPARADA = 600

/** `true` quando o texto ultrapassa o limite (estritamente maior que 600). */
function textoExcedeLimiteDisparo(texto) {
  return String(texto ?? '').length > LIMITE_TEXTO_MENSAGEM_DISPARADA
}

/**
 * Atendimento humano genuíno ANTES deste envio — protege conversas em andamento de serem
 * puxadas para "Mensagens Disparadas" por um único texto longo. Sinais: atendente atribuído,
 * status em_atendimento/aguardando_cliente, ou o cliente já falou (histórico de inbound).
 */
function conversaEmAtendimentoHumanoGenuino({ statusAtendimento, atendenteId, temInbound } = {}) {
  if (temInbound === true) return true
  if (atendenteId != null && String(atendenteId).trim() !== '') return true
  const st = String(statusAtendimento || '').trim().toLowerCase()
  return st === 'em_atendimento' || st === 'aguardando_cliente'
}

/**
 * Decisão pura. Todos os sinais de estado são ANTERIORES ao envio (no caminho do CRM, capturados
 * antes do auto-assumir; no caminho externo/webhook, o estado atual já é confiável).
 */
function deveClassificarComoMensagemDisparada({
  separarAtivo,
  direcao,
  texto,
  isGroup,
  aguardandoRespostaCampanha,
  statusAtendimentoAntes,
  atendenteIdAntes,
  temInbound,
} = {}) {
  if (separarAtivo !== true) return false
  if (String(direcao || '').toLowerCase() !== 'out') return false
  if (isGroup === true) return false
  if (aguardandoRespostaCampanha === true) return false
  if (!textoExcedeLimiteDisparo(texto)) return false
  if (
    conversaEmAtendimentoHumanoGenuino({
      statusAtendimento: statusAtendimentoAntes,
      atendenteId: atendenteIdAntes,
      temInbound,
    })
  ) {
    return false
  }
  return true
}

module.exports = {
  LIMITE_TEXTO_MENSAGEM_DISPARADA,
  textoExcedeLimiteDisparo,
  conversaEmAtendimentoHumanoGenuino,
  deveClassificarComoMensagemDisparada,
}
