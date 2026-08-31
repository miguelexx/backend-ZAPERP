/**
 * Dashboard HTTP handlers — fachada.
 * Implementação em ./dashboard/*.js
 */
const { crmResumo } = require('./crmResumo')
const { overview } = require('./overview')
const { metrics, metricsAvancadas } = require('./metrics')
const {
  listarDepartamentos,
  criarDepartamento,
  atualizarDepartamento,
  excluirDepartamento,
  listarGruposDepartamento,
  atualizarGruposDepartamento,
} = require('./departamentos')
const {
  listarRespostasSalvas,
  criarRespostaSalva,
  atualizarRespostaSalva,
  excluirRespostaSalva,
} = require('./respostasSalvas')
const { relatorioConversas, relatorioMensagens, exportRelatorio } = require('./relatorios')
const {
  getSlaConfig,
  setSlaConfig,
  getSlaAlertas,
  slaResumo,
  slaDiaria,
  slaValidacao,
  exportSla,
} = require('./sla')

module.exports = {
  crmResumo,
  overview,
  metrics,
  metricsAvancadas,
  listarDepartamentos,
  criarDepartamento,
  atualizarDepartamento,
  excluirDepartamento,
  listarGruposDepartamento,
  atualizarGruposDepartamento,
  listarRespostasSalvas,
  criarRespostaSalva,
  atualizarRespostaSalva,
  excluirRespostaSalva,
  relatorioConversas,
  relatorioMensagens,
  exportRelatorio,
  getSlaConfig,
  setSlaConfig,
  getSlaAlertas,
  slaResumo,
  slaDiaria,
  slaValidacao,
  exportSla,
}
