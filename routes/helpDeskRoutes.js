const express = require('express')
const auth = require('../middleware/auth')
const supervisorOrAdmin = require('../middleware/supervisorOrAdmin')
const controller = require('../controllers/helpDeskController')

const router = express.Router()

router.use(auth)

router.post('/tickets', controller.createTicket)
router.get('/tickets', controller.listTickets)
router.get('/tickets/:id', controller.getTicket)
router.patch('/tickets/:id', controller.updateTicket)
router.post('/tickets/:id/messages', controller.addMessage)
router.post('/tickets/:id/transfer', supervisorOrAdmin, controller.transferTicket)

module.exports = router
