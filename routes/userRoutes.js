const express = require('express')
const router = express.Router()
const auth = require('../middleware/auth')
const userController = require('../controllers/userController')
const permissoesController = require('../controllers/permissoesController')
const { loginLimiter } = require('../middleware/rateLimit')

router.get('/', auth, userController.listar)
router.post('/login', loginLimiter, userController.login)

// Minhas permissões — qualquer usuário autenticado (para UI esconder/mostrar menus)
router.get('/me/permissoes', auth, permissoesController.getMinhasPermissoes)

const adminOnly = require('../middleware/adminOnly')
router.post('/', auth, adminOnly, userController.criar)
router.post('/resetar-senha-email', auth, adminOnly, userController.resetarSenhaPorEmail)
router.put('/:id', auth, adminOnly, userController.atualizar)
router.post('/:id/redefinir-senha', auth, adminOnly, userController.redefinirSenha)
router.delete('/:id', auth, adminOnly, userController.excluir)

// Permissões granulares por usuário (admin pode editar; usuário pode ver as próprias)
router.get('/:id/permissoes', auth, permissoesController.getPermissoesUsuario)
router.put('/:id/permissoes', auth, adminOnly, permissoesController.putPermissoesUsuario)

module.exports = router
