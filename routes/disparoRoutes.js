const express = require('express')
const auth = require('../middleware/auth')
const adminOnly = require('../middleware/adminOnly')
const campanhasController = require('../controllers/disparoController')
const destController = require('../controllers/disparoDestinatariosController')
const instController = require('../controllers/disparoInstanciasController')
const { uploadDisparoFile } = require('../middleware/uploadDisparoFile')

const router = express.Router()

router.use(auth)
router.use(adminOnly)

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

module.exports = router
