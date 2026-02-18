const express = require('express')
const router = express.Router()
const auth = require('../middleware/auth')
const userController = require('../controllers/userController')
const { loginLimiter } = require('../middleware/rateLimit')

router.get('/', auth, userController.listar)
router.post('/login', loginLimiter, userController.login)

const adminOnly = require('../middleware/adminOnly')
router.post('/', auth, adminOnly, userController.criar)
router.put('/:id', auth, adminOnly, userController.atualizar)
router.post('/:id/redefinir-senha', auth, adminOnly, userController.redefinirSenha)
router.delete('/:id', auth, adminOnly, userController.excluir)

module.exports = router
