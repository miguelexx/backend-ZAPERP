const express = require('express')
const auth = require('../middleware/auth')
const integrationAuth = require('../middleware/helpDeskIntegrationAuth')
const supervisorOrAdmin = require('../middleware/supervisorOrAdmin')
const controller = require('../controllers/helpDeskController')

const router = express.Router()

router.post('/tickets', integrationAuth.integrationOnly, controller.createTicket)
router.get('/tickets', integrationAuth.integrationOrUser, controller.listTickets)
router.get('/tickets/:id', integrationAuth.integrationOrUser, controller.getTicket)
router.post('/tickets/:id/messages', integrationAuth.integrationOrUser, controller.addMessage)
router.patch('/tickets/:id', auth, controller.updateTicket)
router.post('/tickets/:id/transfer', auth, supervisorOrAdmin, controller.transferTicket)

module.exports = router
