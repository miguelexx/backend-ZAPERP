const express = require('express')
const auth = require('../middleware/auth')
const adminOnly = require('../middleware/adminOnly')
const campanhasController = require('../controllers/disparoController')
const destController = require('../controllers/disparoDestinatariosController')
const instController = require('../controllers/disparoInstanciasController')
const varController = require('../controllers/disparoVariacoesController')
const limitesController = require('../controllers/disparoLimitesController')
const revisaoController = require('../controllers/disparoRevisaoController')
const execController = require('../controllers/disparoExecucaoController')
const exclController = require('../controllers/disparoExclusaoController')
const etapa8Controller = require('../controllers/disparoEtapa8Controller')
const saudeController = require('../controllers/disparoSaudeController')
const { uploadDisparoFile } = require('../middleware/uploadDisparoFile')
const { uploadDisparoMidia } = require('../middleware/uploadDisparoMidia')

const router = express.Router()

router.use(auth)
router.use(adminOnly)

// ── Saúde operacional (Etapa 9) ─────────────────────────────────────────────
router.get('/saude', saudeController.obterSaude)

// ── Campanhas ────────────────────────────────────────────────────────────────
router.get('/campanhas/resumo', campanhasController.resumoCampanhas)
router.get('/campanhas', campanhasController.listarCampanhas)
router.get('/campanhas/:id', campanhasController.obterCampanha)
router.post('/campanhas', campanhasController.criarCampanha)
router.patch('/campanhas/:id', campanhasController.editarCampanha)
router.post('/campanhas/:id/arquivar', campanhasController.arquivarCampanha)
router.post('/campanhas/:id/restaurar', campanhasController.restaurarCampanha)

// ── Destinatários — busca de contatos ZapERP ─────────────────────────────────
router.get('/campanhas/:id/contatos', destController.buscarContatos)

// ── Destinatários — listagem, resumo e não atribuídos ────────────────────────
router.get('/campanhas/:id/destinatarios/resumo', destController.resumoDestinatarios)
router.get('/campanhas/:id/destinatarios/nao-atribuidos', instController.destinatariosNaoAtribuidos)
router.get('/campanhas/:id/destinatarios', destController.listarDestinatarios)

// ── Destinatários — adicionar / importar ─────────────────────────────────────
router.post('/campanhas/:id/destinatarios/add-contatos', destController.addContatos)
router.post('/campanhas/:id/destinatarios/preview', uploadDisparoFile, destController.previewImportacao)
router.post('/campanhas/:id/destinatarios/confirmar-importacao', uploadDisparoFile, destController.confirmarImportacao)

// ── Destinatários — remover ───────────────────────────────────────────────────
router.post('/campanhas/:id/destinatarios/remover-varios', destController.removerVarios)
router.delete('/campanhas/:id/destinatarios', destController.limparDestinatarios)
router.delete('/campanhas/:id/destinatarios/:destId', destController.removerDestinatario)

// ── Instâncias — listagem e seleção ──────────────────────────────────────────
router.get('/campanhas/:id/instancias/disponiveis', instController.listarInstanciasDisponiveis)
router.get('/campanhas/:id/instancias/resumo', instController.resumoInstancias)
router.post('/campanhas/:id/instancias/selecionar', instController.selecionarInstancias)
router.delete('/campanhas/:id/instancias/:instanciaId', instController.removerInstancia)

// ── Instâncias — distribuição ─────────────────────────────────────────────────
router.post('/campanhas/:id/instancias/preview-distribuicao', instController.previewDistribuicao)
router.post('/campanhas/:id/instancias/confirmar-distribuicao', instController.confirmarDistribuicao)
router.post('/campanhas/:id/instancias/recalcular', instController.recalcularDistribuicao)

// ── Instâncias — atribuição manual ───────────────────────────────────────────
router.post('/campanhas/:id/instancias/atribuir-manual', instController.atribuirManual)
router.post('/campanhas/:id/instancias/mover', instController.moverDestinatarios)

// ── Variações — CRUD ─────────────────────────────────────────────────────────
router.get('/campanhas/:id/variacoes', varController.listarVariacoes)
router.post('/campanhas/:id/variacoes', varController.criarVariacao)
// Rotas literais / com path fixo ANTES de :varId (evita captura indevida)
router.get('/campanhas/:id/variacoes/variaveis', varController.catalogoVariaveis)
router.get('/campanhas/:id/variacoes/variaveis/:chave/sem-valor', varController.destinatariosSemVariavel)
router.get('/campanhas/:id/variacoes/preview/:destId', varController.previewDestinatario)
router.get('/campanhas/:id/variacoes/resumo', varController.resumoMensagens)
router.post('/campanhas/:id/variacoes/reordenar', varController.reordenarVariacoes)
router.post('/campanhas/:id/variacoes/valores-padrao', varController.salvarValoresPadrao)
router.post('/campanhas/:id/variacoes/preview-distribuicao', varController.previewDistribuicaoVariacoes)
router.post('/campanhas/:id/variacoes/confirmar-distribuicao', varController.confirmarDistribuicaoVariacoes)
router.post('/campanhas/:id/variacoes/atribuir-manual', varController.atribuirVariacaoManual)
router.post('/campanhas/:id/variacoes/recalcular', varController.recalcularDistribuicaoVariacoes)
// Rotas com :varId depois das rotas literais
router.post('/campanhas/:id/variacoes/:varId/duplicar', varController.duplicarVariacao)
router.post('/campanhas/:id/variacoes/:varId/midia', uploadDisparoMidia, varController.uploadMidia)
router.patch('/campanhas/:id/variacoes/:varId', varController.editarVariacao)
router.delete('/campanhas/:id/variacoes/:varId/midia', varController.removerMidia)
router.delete('/campanhas/:id/variacoes/:varId', varController.excluirVariacao)

// ── Limites / horários / agendamento (Etapa 5) ───────────────────────────────
router.get('/campanhas/:id/limites', limitesController.obterConfigLimites)
router.get('/campanhas/:id/limites/revisao', limitesController.necessidadeRevisao)
router.get('/campanhas/:id/limites/conflitos', limitesController.localizarConflitos)
router.post('/campanhas/:id/limites', limitesController.salvarLimitesGlobais)
router.post('/campanhas/:id/limites/instancias', limitesController.salvarLimitesInstancias)
router.post('/campanhas/:id/limites/janelas', limitesController.salvarJanelas)
router.post('/campanhas/:id/limites/agendamento', limitesController.salvarAgendamento)
router.post('/campanhas/:id/limites/agendamento/cancelar', limitesController.cancelarAgendamento)
router.post('/campanhas/:id/limites/validar', limitesController.validarConfigLimites)
router.post('/campanhas/:id/limites/conflitos', limitesController.localizarConflitos)
router.post('/campanhas/:id/limites/simular', limitesController.simular)
router.post('/campanhas/:id/limites/confirmar', limitesController.confirmarLimites)

// ── Revisão final (Etapa 6) ───────────────────────────────────────────────────
router.get('/campanhas/:id/revisao', revisaoController.obterRevisao)
router.get('/campanhas/:id/revisao/bloqueio', revisaoController.estadoBloqueio)
router.get('/campanhas/:id/revisao/historico', revisaoController.historicoRevisoes)
router.get('/campanhas/:id/revisao/previa', revisaoController.previaDestinatarios)
router.get('/campanhas/:id/revisao/exportar', revisaoController.exportarResumo)
router.post('/campanhas/:id/revisao/validar', revisaoController.validarRevisao)
router.post('/campanhas/:id/revisao/confirmar', revisaoController.confirmarCampanha)
router.post('/campanhas/:id/revisao/voltar-edicao', revisaoController.voltarEdicao)

// ── Execução / fila (Etapa 7) ───────────────────────────────────────────────
router.post('/campanhas/:id/execucao/iniciar', execController.iniciarCampanha)
router.get('/campanhas/:id/execucao', execController.obterExecucao)
router.get('/campanhas/:id/execucao/resumo', execController.resumoExecucao)
router.get('/campanhas/:id/execucao/fila', execController.listarFila)
router.get('/campanhas/:id/execucao/eventos', execController.listarEventos)
router.get('/campanhas/:id/execucao/instancias', execController.saudeInstancias)
router.post('/campanhas/:id/execucao/pausar', execController.pausar)
router.post('/campanhas/:id/execucao/continuar', execController.continuar)
router.post('/campanhas/:id/execucao/cancelar', execController.cancelar)
router.post('/campanhas/:id/execucao/reprocessar-falhas', execController.reprocessarFalhas)
router.post('/execucao/emergencia', execController.emergencia)
router.get('/worker/saude', execController.saudeWorker)

// ── Exclusões globais (Etapa 7) ───────────────────────────────────────────────
router.get('/exclusoes', exclController.listar)
router.post('/exclusoes', exclController.adicionar)
router.post('/exclusoes/importar', exclController.importar)
router.delete('/exclusoes/:exclId', exclController.remover)

// ── Etapa 8: opt-out, respostas, reconciliação, relatório ───────────────────
router.get('/config/optout', etapa8Controller.obterConfigOptOut)
router.put('/config/optout', etapa8Controller.salvarConfigOptOut)
router.get('/optouts', etapa8Controller.listarOptOuts)
router.post('/optouts/reativar', etapa8Controller.reativarOptOut)
router.get('/campanhas/:id/respostas', etapa8Controller.listarRespostasCampanha)
router.get('/campanhas/:id/incertos', etapa8Controller.listarIncertosCampanha)
router.post('/campanhas/:id/reconciliar', etapa8Controller.reconciliarCampanha)
router.post('/campanhas/:id/incertos/:itemId/decisao', etapa8Controller.decisaoManualIncerto)
router.get('/campanhas/:id/relatorio', etapa8Controller.relatorioCampanha)
router.get('/campanhas/:id/relatorio/instancias', etapa8Controller.relatorioInstancias)
router.get('/campanhas/:id/relatorio/variacoes', etapa8Controller.relatorioVariacoes)
router.get('/campanhas/:id/relatorio/erros', etapa8Controller.relatorioErros)
router.get('/campanhas/:id/export/:tipo', etapa8Controller.exportarCampanha)

module.exports = router
