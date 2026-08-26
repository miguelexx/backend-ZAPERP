'use strict'

// Rota standalone do hand-off (SSO) para o CRM Avançado. Substitui a antiga
// rota que vivia no crmRoutes.js (removido junto com o CRM interno). Só exige
// autenticação do ZapERP; a presença de CRM_AVANCADO_URL/ZAP_SSO_SECRET é o
// interruptor mestre (sem elas, o controller responde 503).

const express = require('express')
const auth = require('../middleware/auth')
const crmSso = require('../controllers/crmSsoController')
const crmLead = require('../controllers/crmLeadController')

const router = express.Router()

router.get('/abrir-avancado', auth, crmSso.abrirCrmAvancado)

// "Enviar ao CRM" a partir de uma conversa → cria/atualiza o lead no CRM Avançado.
router.post('/leads/from-conversa/:conversaId', auth, crmLead.enviarLeadDaConversa)

module.exports = router
