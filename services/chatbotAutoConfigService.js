/**
 * Serviço de Auto-Configuração de Chatbot
 * 
 * Este serviço gerencia a configuração automática do chatbot de triagem
 * para todas as empresas do sistema, garantindo que:
 * 
 * 1. Todas as empresas tenham chatbot configurado automaticamente
 * 2. Novas empresas recebam configuração automática
 * 3. Configurações possam ser personalizadas por empresa
 * 4. Conversas reabertas reiniciem o processo do chatbot
 * 5. Sistema seja escalável para qualquer número de clientes
 */

const supabase = require('../config/supabase')

/**
 * Configuração padrão do chatbot que será aplicada a todas as empresas
 */
const DEFAULT_CHATBOT_TEMPLATE = {
  enabled: true,
  sendOnlyFirstTime: true,
  fallbackToAI: false,
  businessHoursOnly: false,
  transferMode: 'departamento',
  tipo_distribuicao: 'fila',
  reopenMenuCommand: '0',
  intervaloEnvioSegundos: 3,
  foraHorarioEnabled: true,
  horarioInicio: '09:00',
  horarioFim: '18:00',
  diasSemanaDesativados: [0, 6], // Domingo e Sábado
  datasEspecificasFechadas: [],
  enviarMensagemFinalizacao: false,
  invalidOptionMessage: 'Opção inválida. Por favor, responda apenas com o número do setor desejado.',
  confirmSelectionMessage: 'Perfeito! Seu atendimento foi direcionado para o setor {{departamento}}. Em instantes nossa equipe dará continuidade.',
  mensagemForaHorario: 'Olá! Nosso horário de atendimento é de segunda a sexta, das 09h às 18h. Sua mensagem foi recebida e retornaremos no próximo dia útil. Obrigado!',
  mensagemFinalizacao: 'Atendimento finalizado com sucesso. Segue seu protocolo: {{protocolo}}.\nPor favor, informe uma nota entre 0 e 10 para avaliar o atendimento prestado.'
}

/**
 * Gera configuração de chatbot personalizada para uma empresa
 * @param {number} companyId - ID da empresa
 * @param {object} customConfig - Configurações personalizadas (opcional)
 * @returns {Promise<object>} Configuração completa do chatbot
 */
async function generateChatbotConfig(companyId, customConfig = {}) {
  try {
    // Buscar dados da empresa
    const { data: empresa, error: empresaError } = await supabase
      .from('empresas')
      .select('id, nome, ativo')
      .eq('id', companyId)
      .single()

    if (empresaError || !empresa) {
      throw new Error(`Empresa não encontrada: ${companyId}`)
    }

    if (!empresa.ativo) {
      throw new Error(`Empresa inativa: ${companyId}`)
    }

    // Buscar departamentos da empresa
    const { data: departamentos, error: deptError } = await supabase
      .from('departamentos')
      .select('id, nome')
      .eq('company_id', companyId)
      .order('id')

    if (deptError) {
      throw new Error(`Erro ao buscar departamentos: ${deptError.message}`)
    }

    let depts = departamentos || []

    // Se não há departamentos, criar departamentos padrão
    if (depts.length === 0) {
      console.log(`[ChatbotAutoConfig] Criando departamentos padrão para empresa ${companyId}`)
      
      const departamentosPadrao = [
        { nome: 'Comercial' },
        { nome: 'Suporte' },
        { nome: 'Financeiro' },
        { nome: 'Administrativo' }
      ]

      for (const dept of departamentosPadrao) {
        const { data: novoDept, error: insertError } = await supabase
          .from('departamentos')
          .insert({
            company_id: companyId,
            nome: dept.nome
          })
          .select('id, nome')
          .single()

        if (!insertError && novoDept) {
          depts.push(novoDept)
        }
      }
    }

    // Gerar opções do menu baseadas nos departamentos
    const options = depts.map((dept, index) => ({
      key: String(index + 1),
      label: dept.nome,
      departamento_id: dept.id,
      active: true,
      tag_id: null
    }))

    // Montar mensagem de boas-vindas personalizada
    const welcomeMessage = customConfig.welcomeMessage || 
      `Olá! Seja bem-vindo(a) à ${empresa.nome}.\nPara direcionarmos seu atendimento, por favor escolha com qual setor deseja falar:`

    // Configuração completa do chatbot
    const chatbotConfig = {
      chatbot_triage: {
        ...DEFAULT_CHATBOT_TEMPLATE,
        ...customConfig,
        welcomeMessage,
        options
      }
    }

    return chatbotConfig

  } catch (error) {
    console.error(`[ChatbotAutoConfig] Erro ao gerar configuração para empresa ${companyId}:`, error.message)
    throw error
  }
}

/**
 * Configura chatbot para uma empresa específica
 * @param {number} companyId - ID da empresa
 * @param {object} customConfig - Configurações personalizadas (opcional)
 * @returns {Promise<boolean>} Sucesso da operação
 */
async function configureChatbotForCompany(companyId, customConfig = {}) {
  try {
    const config = await generateChatbotConfig(companyId, customConfig)

    const { error } = await supabase
      .from('ia_config')
      .upsert({
        company_id: companyId,
        config: config,
        updated_at: new Date().toISOString()
      })

    if (error) {
      throw new Error(`Erro ao salvar configuração: ${error.message}`)
    }

    console.log(`[ChatbotAutoConfig] ✅ Chatbot configurado para empresa ${companyId}`)
    return true

  } catch (error) {
    console.error(`[ChatbotAutoConfig] ❌ Erro ao configurar chatbot para empresa ${companyId}:`, error.message)
    return false
  }
}

/**
 * Configura chatbot para todas as empresas ativas do sistema
 * @param {object} globalCustomConfig - Configurações personalizadas globais (opcional)
 * @returns {Promise<object>} Resultado da operação
 */
async function configureAllCompaniesChatbot(globalCustomConfig = {}) {
  try {
    console.log('[ChatbotAutoConfig] 🚀 Iniciando configuração para todas as empresas...')

    // Buscar todas as empresas ativas
    const { data: empresas, error: empresasError } = await supabase
      .from('empresas')
      .select('id, nome')
      .eq('ativo', true)
      .order('id')

    if (empresasError) {
      throw new Error(`Erro ao buscar empresas: ${empresasError.message}`)
    }

    if (!empresas || empresas.length === 0) {
      console.log('[ChatbotAutoConfig] ⚠️ Nenhuma empresa ativa encontrada')
      return { success: true, configured: 0, failed: 0, companies: [] }
    }

    const results = {
      success: true,
      configured: 0,
      failed: 0,
      companies: [],
      errors: []
    }

    // Configurar chatbot para cada empresa
    for (const empresa of empresas) {
      try {
        const success = await configureChatbotForCompany(empresa.id, globalCustomConfig)
        
        if (success) {
          results.configured++
          results.companies.push({
            id: empresa.id,
            nome: empresa.nome,
            status: 'configured'
          })
        } else {
          results.failed++
          results.companies.push({
            id: empresa.id,
            nome: empresa.nome,
            status: 'failed'
          })
        }
      } catch (error) {
        results.failed++
        results.errors.push({
          company_id: empresa.id,
          company_name: empresa.nome,
          error: error.message
        })
        results.companies.push({
          id: empresa.id,
          nome: empresa.nome,
          status: 'error',
          error: error.message
        })
      }
    }

    console.log(`[ChatbotAutoConfig] ✅ Configuração concluída: ${results.configured} configuradas, ${results.failed} falharam`)
    return results

  } catch (error) {
    console.error('[ChatbotAutoConfig] ❌ Erro ao configurar todas as empresas:', error.message)
    return {
      success: false,
      error: error.message,
      configured: 0,
      failed: 0,
      companies: []
    }
  }
}

/**
 * Ativa ou desativa o chatbot para uma empresa
 * @param {number} companyId - ID da empresa
 * @param {boolean} enabled - true para ativar, false para desativar
 * @returns {Promise<boolean>} Sucesso da operação
 */
async function toggleChatbotForCompany(companyId, enabled) {
  try {
    // Verificar se configuração existe
    const { data: existingConfig, error: fetchError } = await supabase
      .from('ia_config')
      .select('config')
      .eq('company_id', companyId)
      .single()

    if (fetchError && fetchError.code !== 'PGRST116') {
      throw new Error(`Erro ao buscar configuração: ${fetchError.message}`)
    }

    let config = existingConfig?.config || {}

    // Se não existe configuração, criar uma nova
    if (!existingConfig) {
      config = await generateChatbotConfig(companyId)
    }

    // Atualizar status do chatbot
    if (!config.chatbot_triage) {
      config.chatbot_triage = { ...DEFAULT_CHATBOT_TEMPLATE }
    }
    
    config.chatbot_triage.enabled = enabled

    const { error: updateError } = await supabase
      .from('ia_config')
      .upsert({
        company_id: companyId,
        config: config,
        updated_at: new Date().toISOString()
      })

    if (updateError) {
      throw new Error(`Erro ao atualizar configuração: ${updateError.message}`)
    }

    console.log(`[ChatbotAutoConfig] ✅ Chatbot ${enabled ? 'ativado' : 'desativado'} para empresa ${companyId}`)
    return true

  } catch (error) {
    console.error(`[ChatbotAutoConfig] ❌ Erro ao ${enabled ? 'ativar' : 'desativar'} chatbot para empresa ${companyId}:`, error.message)
    return false
  }
}

/**
 * Verifica status do chatbot para todas as empresas
 * @returns {Promise<Array>} Lista com status de cada empresa
 */
async function getChatbotStatusForAllCompanies() {
  try {
    const { data: result, error } = await supabase
      .from('empresas')
      .select(`
        id,
        nome,
        ativo,
        ia_config (
          config
        )
      `)
      .eq('ativo', true)
      .order('id')

    if (error) {
      throw new Error(`Erro ao buscar status: ${error.message}`)
    }

    return result.map(empresa => {
      const config = empresa.ia_config?.[0]?.config
      const chatbotConfig = config?.chatbot_triage
      
      return {
        company_id: empresa.id,
        company_name: empresa.nome,
        chatbot_configured: !!chatbotConfig,
        chatbot_enabled: chatbotConfig?.enabled || false,
        total_options: chatbotConfig?.options?.length || 0,
        welcome_message_configured: !!chatbotConfig?.welcomeMessage,
        business_hours_enabled: chatbotConfig?.foraHorarioEnabled || false
      }
    })

  } catch (error) {
    console.error('[ChatbotAutoConfig] ❌ Erro ao buscar status das empresas:', error.message)
    throw error
  }
}

/**
 * Reconfigura chatbot para uma empresa (regenera configuração baseada nos departamentos atuais)
 * @param {number} companyId - ID da empresa
 * @param {object} customConfig - Configurações personalizadas (opcional)
 * @returns {Promise<boolean>} Sucesso da operação
 */
async function reconfigureChatbotForCompany(companyId, customConfig = {}) {
  try {
    console.log(`[ChatbotAutoConfig] 🔄 Reconfigurando chatbot para empresa ${companyId}`)
    
    // Limpar logs antigos para permitir teste completo
    await supabase
      .from('bot_logs')
      .delete()
      .eq('company_id', companyId)
      .in('tipo', ['menu_enviado', 'opcao_valida', 'opcao_invalida'])

    // Gerar nova configuração
    return await configureChatbotForCompany(companyId, customConfig)

  } catch (error) {
    console.error(`[ChatbotAutoConfig] ❌ Erro ao reconfigurar chatbot para empresa ${companyId}:`, error.message)
    return false
  }
}

/**
 * Middleware para auto-configuração de chatbot em novas empresas
 * Deve ser chamado após criação de nova empresa
 * @param {number} companyId - ID da nova empresa
 * @returns {Promise<boolean>} Sucesso da operação
 */
async function autoConfigureNewCompany(companyId) {
  try {
    console.log(`[ChatbotAutoConfig] 🆕 Auto-configurando chatbot para nova empresa ${companyId}`)
    return await configureChatbotForCompany(companyId)
  } catch (error) {
    console.error(`[ChatbotAutoConfig] ❌ Erro na auto-configuração da empresa ${companyId}:`, error.message)
    return false
  }
}

module.exports = {
  generateChatbotConfig,
  configureChatbotForCompany,
  configureAllCompaniesChatbot,
  toggleChatbotForCompany,
  getChatbotStatusForAllCompanies,
  reconfigureChatbotForCompany,
  autoConfigureNewCompany,
  DEFAULT_CHATBOT_TEMPLATE
}