const express = require('express')
const auth = require('../middleware/auth')
const adminOnly = require('../middleware/adminOnly')
const campanhasController = require('../controllers/disparoController')
const destController = require('../controllers/disparoDestinatariosController')
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

// ── Destinatários — listagem e resumo ────────────────────────────────────────
router.get('/campanhas/:id/destinatarios/resumo', destController.resumoDestinatarios)
router.get('/campanhas/:id/destinatarios', destController.listarDestinatarios)

// ── Destinatários — busca de contatos ZapERP ─────────────────────────────────
router.get('/campanhas/:id/contatos', destController.buscarContatos)

// ── Destinatários — adicionar / importar ─────────────────────────────────────
router.post('/campanhas/:id/destinatarios/add-contatos', destController.addContatos)
router.post('/campanhas/:id/destinatarios/preview', uploadDisparoFile, destController.previewImportacao)
router.post('/campanhas/:id/destinatarios/confirmar-importacao', uploadDisparoFile, destController.confirmarImportacao)

// ── Destinatários — remover ───────────────────────────────────────────────────
router.post('/campanhas/:id/destinatarios/remover-varios', destController.removerVarios)
router.delete('/campanhas/:id/destinatarios', destController.limparDestinatarios)
router.delete('/campanhas/:id/destinatarios/:destId', destController.removerDestinatario)

module.exports = router
