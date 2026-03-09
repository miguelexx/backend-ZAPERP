const express = require('express')
const auth = require('../middleware/auth')
const supervisorOrAdmin = require('../middleware/supervisorOrAdmin')
const optInOptOutController = require('../controllers/optInOptOutController')

const optInRouter = express.Router()
optInRouter.post('/', auth, supervisorOrAdmin, optInOptOutController.registrarOptIn)

const optOutRouter = express.Router()
optOutRouter.get('/', auth, supervisorOrAdmin, optInOptOutController.listarOptOut)

module.exports = { optInRouter, optOutRouter }
