const express = require('express')
const adminOnly = require('../middleware/adminOnly')
const controller = require('../controllers/atendimentoLimitsController')

const router = express.Router()

router.use(adminOnly)

router.get('/', controller.getConfig)
router.put('/', controller.putCompanyConfig)
router.put('/usuarios/:usuario_id', controller.putUserConfig)

module.exports = router
