/**
 * Status e congelamento da campanha — compartilhado pelas Etapas 1–6.
 */

const STATUS_EDITAVEIS = new Set(['rascunho', 'configurando'])

const STATUS_CONGELADOS = new Set([
  'pronta',
  'agendada',
  'em_execucao',
  'pausada',
  'concluida',
  'cancelada',
  'arquivada',
])

const STATUS_TODOS = new Set([
  'rascunho',
  'configurando',
  'pronta',
  'agendada',
  'em_execucao',
  'pausada',
  'concluida',
  'cancelada',
  'arquivada',
])

function statusPermiteEdicao(status) {
  return STATUS_EDITAVEIS.has(String(status || ''))
}

function statusEstaCongelado(status) {
  return STATUS_CONGELADOS.has(String(status || ''))
}

/** Após confirmação, voltar à edição só é permitido em pronta/agendada (antes de executar). */
function statusPermiteVoltarEdicao(status) {
  return status === 'pronta' || status === 'agendada'
}

function mensagemBloqueioEdicao(status) {
  if (status === 'pronta' || status === 'agendada') {
    return 'Campanha confirmada e congelada. Use "Voltar para edição" na Revisão para alterar.'
  }
  if (status === 'em_execucao' || status === 'pausada') {
    return 'Não é possível alterar uma campanha em execução ou pausada.'
  }
  if (status === 'concluida' || status === 'cancelada' || status === 'arquivada') {
    return 'Não é possível alterar uma campanha finalizada.'
  }
  return 'Não é possível alterar a campanha nesta fase.'
}

module.exports = {
  STATUS_EDITAVEIS,
  STATUS_CONGELADOS,
  STATUS_TODOS,
  statusPermiteEdicao,
  statusEstaCongelado,
  statusPermiteVoltarEdicao,
  mensagemBloqueioEdicao,
}
