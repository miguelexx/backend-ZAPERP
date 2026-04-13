const express = require('express')
const auth = require('../middleware/auth')
const { uploadArquivo } = require('../middleware/upload')
const internalChatController = require('../controllers/internalChatController')

const router = express.Router()

router.use(auth)

router.get('/status', internalChatController.status)

router.get('/employees', internalChatController.listEmployees)

router.get('/client-contacts', internalChatController.listClientContacts)

router.post('/conversations', internalChatController.createOrGetConversation)
router.get('/conversations', internalChatController.listConversations)
router.get('/conversations/:id/messages', internalChatController.listMessages)
router.post('/conversations/:id/messages/media', uploadArquivo, internalChatController.sendMediaMessage)
router.post('/conversations/:id/messages', internalChatController.sendMessage)
router.post('/conversations/:id/read', internalChatController.markRead)

module.exports = router
