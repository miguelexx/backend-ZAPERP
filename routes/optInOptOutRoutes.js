const express = require('express')
const auth = require('../middleware/auth')
const optInOptOutController = require('../controllers/optInOptOutController')

const optInRouter = express.Router()
optInRouter.post('/', auth, optInOptOutController.registrarOptIn)

const optOutRouter = express.Router()
optOutRouter.get('/', auth, optInOptOutController.listarOptOut)

module.exports = { optInRouter, optOutRouter }
