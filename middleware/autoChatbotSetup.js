/**
 * Middleware de Auto-Configuração de Chatbot
 * 
 * Este middleware garante que todas as empresas tenham chatbot configurado
 * automaticamente, incluindo:
 * 
 * 1. Auto-configuração para novas empresas
 * 2. Verificação e configuração automática em empresas existentes
 * 3. Reconfiguração quando departamentos são alterados
 * 4. Garantia de que conversas reabertas reiniciem o processo
 */

const { autoConfigureNewCompany, getChatbotStatusForAllCompanies } = require('../services/chatbotAutoConfigService')

/**
 * Middleware para auto-configurar chatbot após criação de empresa
 * Deve ser usado em rotas que criam empresas
 */
const autoConfigureChatbotOnCompanyCreate = async (req, res, next) => {
  // Interceptar resposta para pegar o ID da empresa criada
  const originalSend = res.send
  
  res.send = function(data) {
    // Restaurar método original
    res.send = originalSend
    
    // Tentar extrair company_id da resposta
    let companyId = null
    
    try {
      if (typeof data === 'string') {
        const parsed = JSON.parse(data)
        companyId = parsed?.data?.id || parsed?.id || parsed?.company_id
      } else if (typeof data === 'object') {
        companyId = data?.data?.id || data?.id || data?.company_id
      }
      
      // Se encontrou company_id, configurar chatbot em background
      if (companyId) {
        console.log(`[AutoChatbotSetup] 🆕 Nova empresa criada (${companyId}), configurando chatbot...`)
        
        // Executar em background para não afetar a resposta
        setImmediate(async () => {
          try {
            const success = await autoConfigureNewCompany(companyId)
            if (success) {
              console.log(`[AutoChatbotSetup] ✅ Chatbot configurado automaticamente para empresa ${companyId}`)
            } else {
              console.warn(`[AutoChatbotSetup] ⚠️ Falha na auto-configuração do chatbot para empresa ${companyId}`)
            }
          } catch (error) {
            console.error(`[AutoChatbotSetup] ❌ Erro na auto-configuração para empresa ${companyId}:`, error.message)
          }
        })
      }
    } catch (error) {
      console.warn('[AutoChatbotSetup] Erro ao processar resposta para auto-configuração:', error.message)
    }
    
    // Enviar resposta original
    return originalSend.call(this, data)
  }
  
  next()
}

/**
 * Middleware para verificar e garantir configuração de chatbot
 * Pode ser usado em rotas críticas para garantir que o chatbot está configurado
 */
const ensureChatbotConfigured = async (req, res, next) => {
  try {
    const companyId = req.body?.company_id || req.params?.company_id || req.query?.company_id
    
    if (!companyId) {
      return next() // Se não há company_id, prosseguir normalmente
    }
    
    // Verificar se chatbot está configurado
    const status = await getChatbotStatusForAllCompanies()
    const companyStatus = status.find(s => s.company_id === parseInt(companyId))
    
    if (!companyStatus?.chatbot_configured) {
      console.log(`[AutoChatbotSetup] 🔧 Chatbot não configurado para empresa ${companyId}, configurando...`)
      
      // Configurar em background
      setImmediate(async () => {
        try {
          const success = await autoConfigureNewCompany(companyId)
          if (success) {
            console.log(`[AutoChatbotSetup] ✅ Chatbot configurado automaticamente para empresa ${companyId}`)
          }
        } catch (error) {
          console.error(`[AutoChatbotSetup] ❌ Erro na configuração automática para empresa ${companyId}:`, error.message)
        }
      })
    }
    
    next()
  } catch (error) {
    console.warn('[AutoChatbotSetup] Erro no middleware de verificação:', error.message)
    next() // Continuar mesmo com erro para não quebrar a aplicação
  }
}

/**
 * Middleware para garantir reinício do chatbot em conversas reabertas
 * Deve ser usado no webhook de mensagens
 */
const ensureChatbotRestart = (req, res, next) => {
  // Marcar no contexto da requisição que deve verificar reinício do chatbot
  req.shouldCheckChatbotRestart = true
  next()
}

/**
 * Função utilitária para verificar se uma conversa foi reaberta
 * e marcar para reinício do chatbot
 */
const checkAndMarkChatbotRestart = async (supabaseClient, conversaId, companyId) => {
  try {
    // Verificar se a conversa estava finalizada
    const { data: conversa, error } = await supabaseClient
      .from('conversas')
      .select('status_atendimento, ultima_atividade, departamento_id')
      .eq('id', conversaId)
      .eq('company_id', companyId)
      .single()

    if (error || !conversa) {
      return false
    }

    // Se estava finalizada e agora recebeu mensagem, é uma reabertura
    const wasFinalized = conversa.status_atendimento === 'finalizada'
    
    if (wasFinalized) {
      console.log(`[AutoChatbotSetup] 🔄 Conversa ${conversaId} foi reaberta, reiniciando chatbot`)
      
      // Limpar logs do chatbot para permitir reinício completo
      await supabaseClient
        .from('bot_logs')
        .delete()
        .eq('conversa_id', conversaId)
        .eq('company_id', companyId)
        .in('tipo', ['menu_enviado', 'opcao_valida', 'opcao_invalida', 'menu_reenviado'])

      // Resetar estado da conversa para permitir nova triagem
      await supabaseClient
        .from('conversas')
        .update({
          departamento_id: null,
          atendente_id: null,
          status_atendimento: 'aberta',
          ultima_atividade: new Date().toISOString()
        })
        .eq('id', conversaId)
        .eq('company_id', companyId)

      console.log(`[AutoChatbotSetup] ✅ Estado da conversa ${conversaId} resetado para nova triagem`)
      return true
    }

    return false
  } catch (error) {
    console.error('[AutoChatbotSetup] Erro ao verificar reinício do chatbot:', error.message)
    return false
  }
}

/**
 * Middleware para auto-configuração quando departamentos são alterados
 * Deve ser usado em rotas que modificam departamentos
 */
const autoReconfigureOnDepartmentChange = async (req, res, next) => {
  const originalSend = res.send
  
  res.send = function(data) {
    res.send = originalSend
    
    // Extrair company_id da requisição
    const companyId = req.body?.company_id || req.params?.company_id || req.query?.company_id
    
    if (companyId) {
      console.log(`[AutoChatbotSetup] 🔄 Departamentos alterados para empresa ${companyId}, reconfigurando chatbot...`)
      
      // Reconfigurar em background
      setImmediate(async () => {
        try {
          const { reconfigureChatbotForCompany } = require('../services/chatbotAutoConfigService')
          const success = await reconfigureChatbotForCompany(companyId)
          if (success) {
            console.log(`[AutoChatbotSetup] ✅ Chatbot reconfigurado após alteração de departamentos para empresa ${companyId}`)
          }
        } catch (error) {
          console.error(`[AutoChatbotSetup] ❌ Erro na reconfiguração para empresa ${companyId}:`, error.message)
        }
      })
    }
    
    return originalSend.call(this, data)
  }
  
  next()
}

/**
 * Função para inicializar configuração de chatbot no startup da aplicação
 * Deve ser chamada no app.js ou index.js
 */
const initializeChatbotForAllCompanies = async () => {
  try {
    console.log('[AutoChatbotSetup] 🚀 Inicializando configuração de chatbot para todas as empresas...')
    
    const { configureAllCompaniesChatbot } = require('../services/chatbotAutoConfigService')
    const result = await configureAllCompaniesChatbot()
    
    if (result.success) {
      console.log(`[AutoChatbotSetup] ✅ Inicialização concluída: ${result.configured} empresas configuradas`)
      if (result.failed > 0) {
        console.warn(`[AutoChatbotSetup] ⚠️ ${result.failed} empresas falharam na configuração`)
      }
    } else {
      console.error('[AutoChatbotSetup] ❌ Falha na inicialização:', result.error)
    }
    
    return result
  } catch (error) {
    console.error('[AutoChatbotSetup] ❌ Erro na inicialização do chatbot:', error.message)
    return { success: false, error: error.message }
  }
}

/**
 * Middleware de healthcheck para chatbot
 * Verifica se todas as empresas têm chatbot configurado
 */
const chatbotHealthCheck = async (req, res, next) => {
  try {
    const status = await getChatbotStatusForAllCompanies()
    
    const totalCompanies = status.length
    const configuredCompanies = status.filter(s => s.chatbot_configured).length
    const enabledCompanies = status.filter(s => s.chatbot_enabled).length
    
    req.chatbotHealthStatus = {
      total_companies: totalCompanies,
      configured_companies: configuredCompanies,
      enabled_companies: enabledCompanies,
      configuration_rate: totalCompanies > 0 ? (configuredCompanies / totalCompanies * 100).toFixed(1) + '%' : '0%',
      activation_rate: configuredCompanies > 0 ? (enabledCompanies / configuredCompanies * 100).toFixed(1) + '%' : '0%',
      details: status
    }
    
    next()
  } catch (error) {
    req.chatbotHealthStatus = {
      error: error.message,
      status: 'unhealthy'
    }
    next()
  }
}

module.exports = {
  autoConfigureChatbotOnCompanyCreate,
  ensureChatbotConfigured,
  ensureChatbotRestart,
  checkAndMarkChatbotRestart,
  autoReconfigureOnDepartmentChange,
  initializeChatbotForAllCompanies,
  chatbotHealthCheck
}