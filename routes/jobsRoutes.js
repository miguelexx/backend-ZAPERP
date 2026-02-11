const express = require('express')
const router = express.Router()
const jobsController = require('../controllers/jobsController')

router.post('/timeout-inatividade', jobsController.checkCronSecret, jobsController.timeoutInatividade)

module.exports = router
