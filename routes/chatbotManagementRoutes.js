/**
 * Rotas de Gerenciamento de Chatbot
 * 
 * Endpoints para gerenciar configuração de chatbot para todas as empresas:
 * 
 * - GET /chatbot/status - Status de todas as empresas
 * - POST /chatbot/configure-all - Configurar todas as empresas
 * - POST /chatbot/configure/:companyId - Configurar empresa específica
 * - PUT /chatbot/toggle/:companyId - Ativar/desativar chatbot
 * - POST /chatbot/reconfigure/:companyId - Reconfigurar empresa
 * - GET /chatbot/health - Health check do sistema de chatbot
 * - POST /chatbot/test/:companyId - Testar configuração
 */

const express = require('express')
const router = express.Router()
const auth = require('../middleware/auth')
const adminOnly = require('../middleware/adminOnly')

const {
  generateChatbotConfig,
  configureChatbotForCompany,
  configureAllCompaniesChatbot,
  toggleChatbotForCompany,
  getChatbotStatusForAllCompanies,
  reconfigureChatbotForCompany
} = require('../services/chatbotAutoConfigService')

const { chatbotHealthCheck } = require('../middleware/autoChatbotSetup')
const {
  DEFAULT_CHATBOT_CONFIG,
  validateChatbotConfig,
  normalizeChatbotTriageStrings,
  invalidateChatbotConfigCache,
} = require('../services/chatbotTriageService')

router.use(auth)
router.use(adminOnly)

/**
 * GET /api/chatbot/status
 * Retorna status do chatbot para todas as empresas
 */
router.get('/status', async (req, res) => {
  try {
    const status = await getChatbotStatusForAllCompanies()
    const companyStatus = status.filter(s => Number(s.company_id) === Number(req.user.company_id))
    
    const summary = {
      total_companies: companyStatus.length,
      configured_companies: companyStatus.filter(s => s.chatbot_configured).length,
      enabled_companies: companyStatus.filter(s => s.chatbot_enabled).length,
      companies: companyStatus
    }
    
    res.json({
      success: true,
      data: summary
    })
  } catch (error) {
    console.error('[ChatbotRoutes] Erro ao buscar status:', error.message)
    res.status(500).json({
      success: false,
      error: 'Erro ao buscar status do chatbot',
      details: error.message
    })
  }
})

/**
 * POST /api/chatbot/configure-all
 * Configura chatbot para todas as empresas ativas
 */
router.post('/configure-all', async (req, res) => {
  return res.status(403).json({
    success: false,
    error: 'Configuração global de todas as empresas não está disponível por esta API'
  })

  try {
    const customConfig = req.body.config || {}
    
    console.log('[ChatbotRoutes] Iniciando configuração para todas as empresas...')
    const result = await configureAllCompaniesChatbot(customConfig)
    
    if (result.success) {
      res.json({
        success: true,
        message: 'Configuração concluída com sucesso',
        data: result
      })
    } else {
      res.status(500).json({
        success: false,
        error: 'Falha na configuração',
        details: result.error
      })
    }
  } catch (error) {
    console.error('[ChatbotRoutes] Erro ao configurar todas as empresas:', error.message)
    res.status(500).json({
      success: false,
      error: 'Erro interno do servidor',
      details: error.message
    })
  }
})

/**
 * POST /api/chatbot/configure/:companyId
 * Configura chatbot para uma empresa específica
 */
router.post('/configure/:companyId', async (req, res) => {
  try {
    const companyId = parseInt(req.params.companyId)
    const customConfig = req.body.config || {}
    
    if (!companyId || isNaN(companyId)) {
      return res.status(400).json({
        success: false,
        error: 'ID da empresa inválido'
      })
    }
    
    if (companyId !== Number(req.user.company_id)) {
      return res.status(403).json({ success: false, error: 'Acesso negado para esta empresa' })
    }

    console.log(`[ChatbotRoutes] Configurando chatbot para empresa ${companyId}`)
    const success = await configureChatbotForCompany(companyId, customConfig)
    
    if (success) {
      res.json({
        success: true,
        message: `Chatbot configurado com sucesso para empresa ${companyId}`
      })
    } else {
      res.status(500).json({
        success: false,
        error: `Falha ao configurar chatbot para empresa ${companyId}`
      })
    }
  } catch (error) {
    console.error(`[ChatbotRoutes] Erro ao configurar empresa ${req.params.companyId}:`, error.message)
    res.status(500).json({
      success: false,
      error: 'Erro ao configurar chatbot',
      details: error.message
    })
  }
})

/**
 * PUT /api/chatbot/toggle/:companyId
 * Ativa ou desativa chatbot para uma empresa
 */
router.put('/toggle/:companyId', async (req, res) => {
  try {
    const companyId = parseInt(req.params.companyId)
    const { enabled } = req.body
    
    if (!companyId || isNaN(companyId)) {
      return res.status(400).json({
        success: false,
        error: 'ID da empresa inválido'
      })
    }
    
    if (companyId !== Number(req.user.company_id)) {
      return res.status(403).json({ success: false, error: 'Acesso negado para esta empresa' })
    }

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: 'Parâmetro "enabled" deve ser boolean'
      })
    }
    
    console.log(`[ChatbotRoutes] ${enabled ? 'Ativando' : 'Desativando'} chatbot para empresa ${companyId}`)
    const success = await toggleChatbotForCompany(companyId, enabled)
    
    if (success) {
      res.json({
        success: true,
        message: `Chatbot ${enabled ? 'ativado' : 'desativado'} com sucesso para empresa ${companyId}`
      })
    } else {
      res.status(500).json({
        success: false,
        error: `Falha ao ${enabled ? 'ativar' : 'desativar'} chatbot para empresa ${companyId}`
      })
    }
  } catch (error) {
    console.error(`[ChatbotRoutes] Erro ao alterar status do chatbot para empresa ${req.params.companyId}:`, error.message)
    res.status(500).json({
      success: false,
      error: 'Erro ao alterar status do chatbot',
      details: error.message
    })
  }
})

/**
 * POST /api/chatbot/reconfigure/:companyId
 * Reconfigura chatbot para uma empresa (regenera baseado nos departamentos atuais)
 */
router.post('/reconfigure/:companyId', async (req, res) => {
  try {
    const companyId = parseInt(req.params.companyId)
    const customConfig = req.body.config || {}
    
    if (!companyId || isNaN(companyId)) {
      return res.status(400).json({
        success: false,
        error: 'ID da empresa inválido'
      })
    }
    
    if (companyId !== Number(req.user.company_id)) {
      return res.status(403).json({ success: false, error: 'Acesso negado para esta empresa' })
    }

    console.log(`[ChatbotRoutes] Reconfigurando chatbot para empresa ${companyId}`)
    const success = await reconfigureChatbotForCompany(companyId, customConfig)
    
    if (success) {
      res.json({
        success: true,
        message: `Chatbot reconfigurado com sucesso para empresa ${companyId}`
      })
    } else {
      res.status(500).json({
        success: false,
        error: `Falha ao reconfigurar chatbot para empresa ${companyId}`
      })
    }
  } catch (error) {
    console.error(`[ChatbotRoutes] Erro ao reconfigurar empresa ${req.params.companyId}:`, error.message)
    res.status(500).json({
      success: false,
      error: 'Erro ao reconfigurar chatbot',
      details: error.message
    })
  }
})

/**
 * GET /api/chatbot/health
 * Health check do sistema de chatbot
 */
router.get('/health', chatbotHealthCheck, (req, res) => {
  const healthStatus = req.chatbotHealthStatus
  
  if (healthStatus.error) {
    return res.status(500).json({
      success: false,
      status: 'unhealthy',
      error: healthStatus.error
    })
  }
  
  const details = Array.isArray(healthStatus.details)
    ? healthStatus.details.filter(s => Number(s.company_id) === Number(req.user.company_id))
    : []
  const scopedHealthStatus = {
    ...healthStatus,
    total_companies: details.length,
    configured_companies: details.filter(s => s.chatbot_configured).length,
    enabled_companies: details.filter(s => s.chatbot_enabled).length,
    details
  }

  const isHealthy = scopedHealthStatus.total_companies > 0 &&
                   scopedHealthStatus.configured_companies === scopedHealthStatus.total_companies
  
  res.status(isHealthy ? 200 : 206).json({
    success: true,
    status: isHealthy ? 'healthy' : 'partial',
    data: scopedHealthStatus
  })
})

/**
 * POST /api/chatbot/test/:companyId
 * Testa configuração do chatbot para uma empresa
 */
router.post('/test/:companyId', async (req, res) => {
  try {
    const companyId = parseInt(req.params.companyId)
    
    if (!companyId || isNaN(companyId)) {
      return res.status(400).json({
        success: false,
        error: 'ID da empresa inválido'
      })
    }
    
    // Gerar configuração de teste
    if (companyId !== Number(req.user.company_id)) {
      return res.status(403).json({ success: false, error: 'Acesso negado para esta empresa' })
    }

    const config = await generateChatbotConfig(companyId)
    
    // Verificar se configuração é válida
    const chatbotConfig = config.chatbot_triage
    const isValid = !!(
      chatbotConfig &&
      chatbotConfig.welcomeMessage &&
      chatbotConfig.options &&
      chatbotConfig.options.length > 0 &&
      chatbotConfig.options.every(opt => opt.key && opt.label && opt.departamento_id)
    )
    
    const testResult = {
      company_id: companyId,
      config_valid: isValid,
      welcome_message: chatbotConfig?.welcomeMessage,
      total_options: chatbotConfig?.options?.length || 0,
      options: chatbotConfig?.options || [],
      enabled: chatbotConfig?.enabled || false,
      business_hours_enabled: chatbotConfig?.foraHorarioEnabled || false,
      reopen_command: chatbotConfig?.reopenMenuCommand || '0'
    }
    
    if (isValid) {
      res.json({
        success: true,
        message: 'Configuração do chatbot é válida',
        data: testResult
      })
    } else {
      res.status(400).json({
        success: false,
        error: 'Configuração do chatbot é inválida',
        data: testResult
      })
    }
  } catch (error) {
    console.error(`[ChatbotRoutes] Erro ao testar configuração para empresa ${req.params.companyId}:`, error.message)
    res.status(500).json({
      success: false,
      error: 'Erro ao testar configuração do chatbot',
      details: error.message
    })
  }
})

/**
 * GET /api/chatbot/config/:companyId
 * Retorna configuração atual do chatbot para uma empresa
 */
router.get('/config/:companyId', async (req, res) => {
  try {
    const companyId = parseInt(req.params.companyId)
    
    if (!companyId || isNaN(companyId)) {
      return res.status(400).json({
        success: false,
        error: 'ID da empresa inválido'
      })
    }
    
    if (companyId !== Number(req.user.company_id)) {
      return res.status(403).json({ success: false, error: 'Acesso negado para esta empresa' })
    }

    const supabase = require('../config/supabase')
    
    const { data: config, error } = await supabase
      .from('ia_config')
      .select('config')
      .eq('company_id', companyId)
      .single()
    
    if (error && error.code !== 'PGRST116') {
      throw new Error(error.message)
    }
    
    if (!config) {
      return res.status(404).json({
        success: false,
        error: 'Configuração não encontrada para esta empresa'
      })
    }
    
    const ctRaw = config.config?.chatbot_triage || {}
    const ctMerged = { ...DEFAULT_CHATBOT_CONFIG, ...ctRaw }
    const ctOut = validateChatbotConfig(ctMerged) || normalizeChatbotTriageStrings(ctMerged)

    res.json({
      success: true,
      data: {
        company_id: companyId,
        config: ctOut
      }
    })
  } catch (error) {
    console.error(`[ChatbotRoutes] Erro ao buscar configuração para empresa ${req.params.companyId}:`, error.message)
    res.status(500).json({
      success: false,
      error: 'Erro ao buscar configuração do chatbot',
      details: error.message
    })
  }
})

/**
 * PUT /api/chatbot/config/:companyId
 * Atualiza configuração específica do chatbot para uma empresa
 */
router.put('/config/:companyId', async (req, res) => {
  try {
    const companyId = parseInt(req.params.companyId)
    const { config } = req.body
    
    if (!companyId || isNaN(companyId)) {
      return res.status(400).json({
        success: false,
        error: 'ID da empresa inválido'
      })
    }
    
    if (companyId !== Number(req.user.company_id)) {
      return res.status(403).json({ success: false, error: 'Acesso negado para esta empresa' })
    }

    if (!config || typeof config !== 'object') {
      return res.status(400).json({
        success: false,
        error: 'Configuração inválida'
      })
    }
    
    const supabase = require('../config/supabase')
    
    // Buscar configuração atual
    const { data: currentConfig, error: fetchError } = await supabase
      .from('ia_config')
      .select('config')
      .eq('company_id', companyId)
      .single()
    
    if (fetchError && fetchError.code !== 'PGRST116') {
      throw new Error(fetchError.message)
    }
    
    // Mesclar configuração atual com nova (textos com mojibake são normalizados)
    const fullConfig = currentConfig?.config || {}
    const ctMerged = { ...DEFAULT_CHATBOT_CONFIG, ...(fullConfig.chatbot_triage || {}), ...config }
    fullConfig.chatbot_triage = validateChatbotConfig(ctMerged) || normalizeChatbotTriageStrings(ctMerged)

    // Atualizar configuração
    const { error: updateError } = await supabase
      .from('ia_config')
      .upsert({
        company_id: companyId,
        config: fullConfig,
        updated_at: new Date().toISOString()
      })
    
    if (updateError) {
      throw new Error(updateError.message)
    }

    invalidateChatbotConfigCache(companyId)

    res.json({
      success: true,
      message: `Configuração atualizada com sucesso para empresa ${companyId}`
    })
  } catch (error) {
    console.error(`[ChatbotRoutes] Erro ao atualizar configuração para empresa ${req.params.companyId}:`, error.message)
    res.status(500).json({
      success: false,
      error: 'Erro ao atualizar configuração do chatbot',
      details: error.message
    })
  }
})

module.exports = router
