/**
 * Rotas de Labels do WhatsApp Business (Whapi). Montadas em /labels e /api/labels.
 * Só empresas com instância Whapi (o controller responde 501 caso contrário).
 * Gestão (criar/editar/apagar) exige admin — espelha a política de /tags.
 */

const express = require('express')
const router = express.Router()
const auth = require('../middleware/auth')
const adminOnly = require('../middleware/adminOnly')
const { destructiveLimiter } = require('../middleware/rateLimit')
const labelsController = require('../controllers/labelsController')

router.get('/', auth, labelsController.listarLabels)
router.post('/', auth, adminOnly, labelsController.criarLabel)
router.patch('/:labelId', auth, adminOnly, labelsController.renomearLabel)
router.delete('/:labelId', auth, adminOnly, destructiveLimiter, labelsController.excluirLabel)

router.get('/:labelId/chats', auth, labelsController.listarAssociacoes)
router.post('/:labelId/associacoes', auth, labelsController.associarChat)
router.delete('/:labelId/associacoes', auth, labelsController.desassociarChat)

module.exports = router
