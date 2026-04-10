/**
 * Rotas de Debug e Diagnóstico do Chatbot
 * 
 * Endpoints para debug e diagnóstico do sistema de chatbot:
 * 
 * - GET /debug/logs/:companyId - Logs do chatbot para uma empresa
 * - GET /debug/conversation/:conversaId - Debug de uma conversa específica
 * - POST /debug/simulate/:companyId - Simular interação com chatbot
 * - GET /debug/metrics/:companyId - Métricas do chatbot
 * - POST /debug/reset/:companyId - Resetar estado do chatbot
 * - GET /debug/validate/:companyId - Validar configuração
 */

const express = require('express')
const router = express.Router()
const supabase = require('../config/supabase')
const {
  DEFAULT_CHATBOT_CONFIG,
  validateChatbotConfig,
  normalizeChatbotTriageStrings,
} = require('../services/chatbotTriageService')

/**
 * GET /api/chatbot/debug/logs/:companyId
 * Retorna logs do chatbot para uma empresa
 */
router.get('/logs/:companyId', async (req, res) => {
  try {
    const companyId = parseInt(req.params.companyId)
    const { limit = 50, offset = 0, tipo, conversa_id } = req.query
    
    if (!companyId || isNaN(companyId)) {
      return res.status(400).json({
        success: false,
        error: 'ID da empresa inválido'
      })
    }
    
    let query = supabase
      .from('bot_logs')
      .select(`
        *,
        conversas (
          id,
          telefone,
          nome_contato_cache
        )
      `)
      .eq('company_id', companyId)
      .order('criado_em', { ascending: false })
      .range(offset, offset + limit - 1)
    
    if (tipo) {
      query = query.eq('tipo', tipo)
    }
    
    if (conversa_id) {
      query = query.eq('conversa_id', parseInt(conversa_id))
    }
    
    const { data: logs, error } = await query
    
    if (error) {
      throw new Error(error.message)
    }
    
    // Estatísticas dos logs
    const { data: stats, error: statsError } = await supabase
      .from('bot_logs')
      .select('tipo')
      .eq('company_id', companyId)
    
    const statistics = {}
    if (!statsError && stats) {
      stats.forEach(log => {
        statistics[log.tipo] = (statistics[log.tipo] || 0) + 1
      })
    }
    
    res.json({
      success: true,
      data: {
        logs,
        statistics,
        pagination: {
          limit: parseInt(limit),
          offset: parseInt(offset),
          total: logs.length
        }
      }
    })
  } catch (error) {
    console.error('[ChatbotDebug] Erro ao buscar logs:', error.message)
    res.status(500).json({
      success: false,
      error: 'Erro ao buscar logs do chatbot',
      details: error.message
    })
  }
})

/**
 * GET /api/chatbot/debug/conversation/:conversaId
 * Debug detalhado de uma conversa específica
 */
router.get('/conversation/:conversaId', async (req, res) => {
  try {
    const conversaId = parseInt(req.params.conversaId)
    
    if (!conversaId || isNaN(conversaId)) {
      return res.status(400).json({
        success: false,
        error: 'ID da conversa inválido'
      })
    }
    
    // Buscar dados da conversa
    const { data: conversa, error: conversaError } = await supabase
      .from('conversas')
      .select(`
        *,
        departamentos (
          id,
          nome
        ),
        usuarios (
          id,
          nome
        )
      `)
      .eq('id', conversaId)
      .single()
    
    if (conversaError) {
      throw new Error(conversaError.message)
    }
    
    // Buscar mensagens da conversa
    const { data: mensagens, error: mensagensError } = await supabase
      .from('mensagens')
      .select('*')
      .eq('conversa_id', conversaId)
      .order('criado_em', { ascending: true })
    
    if (mensagensError) {
      throw new Error(mensagensError.message)
    }
    
    // Buscar logs do chatbot para esta conversa
    const { data: botLogs, error: logsError } = await supabase
      .from('bot_logs')
      .select('*')
      .eq('conversa_id', conversaId)
      .order('criado_em', { ascending: true })
    
    if (logsError) {
      throw new Error(logsError.message)
    }
    
    // Buscar configuração do chatbot da empresa
    const { data: config, error: configError } = await supabase
      .from('ia_config')
      .select('config')
      .eq('company_id', conversa.company_id)
      .single()
    
    const rawTriage = config?.config?.chatbot_triage || {}
    const triageMerged = { ...DEFAULT_CHATBOT_CONFIG, ...rawTriage }
    const chatbotConfig =
      validateChatbotConfig(triageMerged) || normalizeChatbotTriageStrings(triageMerged)

    // Análise da conversa
    const analysis = {
      total_mensagens: mensagens.length,
      mensagens_cliente: mensagens.filter(m => m.direcao === 'in').length,
      mensagens_bot: mensagens.filter(m => m.direcao === 'out' && m.texto?.includes('Olá!')).length,
      primeira_mensagem: mensagens[0],
      ultima_mensagem: mensagens[mensagens.length - 1],
      chatbot_ativo: !!chatbotConfig?.enabled,
      menu_enviado: botLogs.some(log => log.tipo === 'menu_enviado'),
      opcao_selecionada: botLogs.find(log => log.tipo === 'opcao_valida'),
      opcoes_invalidas: botLogs.filter(log => log.tipo === 'opcao_invalida').length
    }
    
    res.json({
      success: true,
      data: {
        conversa,
        mensagens,
        bot_logs: botLogs,
        chatbot_config: chatbotConfig,
        analysis
      }
    })
  } catch (error) {
    console.error('[ChatbotDebug] Erro ao buscar debug da conversa:', error.message)
    res.status(500).json({
      success: false,
      error: 'Erro ao buscar debug da conversa',
      details: error.message
    })
  }
})

/**
 * POST /api/chatbot/debug/simulate/:companyId
 * Simula interação com o chatbot
 */
router.post('/simulate/:companyId', async (req, res) => {
  try {
    const companyId = parseInt(req.params.companyId)
    const { telefone = '5511999999999', texto = 'Olá', reset = false } = req.body
    
    if (!companyId || isNaN(companyId)) {
      return res.status(400).json({
        success: false,
        error: 'ID da empresa inválido'
      })
    }
    
    // Buscar ou criar cliente de teste
    const { data: cliente, error: clienteError } = await supabase
      .from('clientes')
      .select('id')
      .eq('telefone', telefone)
      .eq('company_id', companyId)
      .maybeSingle()
    
    let clienteId = cliente?.id
    
    if (!clienteId) {
      const { data: novoCliente, error: novoClienteError } = await supabase
        .from('clientes')
        .insert({
          telefone,
          nome: 'Cliente Teste',
          company_id: companyId
        })
        .select('id')
        .single()
      
      if (novoClienteError) {
        throw new Error(novoClienteError.message)
      }
      
      clienteId = novoCliente.id
    }
    
    // Buscar ou criar conversa de teste
    const { data: conversa, error: conversaError } = await supabase
      .from('conversas')
      .select('id')
      .eq('cliente_id', clienteId)
      .eq('company_id', companyId)
      .maybeSingle()
    
    let conversaId = conversa?.id
    
    if (!conversaId || reset) {
      if (conversaId && reset) {
        // Limpar logs e mensagens para reset
        await supabase.from('bot_logs').delete().eq('conversa_id', conversaId)
        await supabase.from('mensagens').delete().eq('conversa_id', conversaId)
        await supabase
          .from('conversas')
          .update({
            departamento_id: null,
            atendente_id: null,
            status_atendimento: 'aberta'
          })
          .eq('id', conversaId)
      } else {
        const { data: novaConversa, error: novaConversaError } = await supabase
          .from('conversas')
          .insert({
            cliente_id: clienteId,
            company_id: companyId,
            telefone,
            nome_contato_cache: 'Cliente Teste',
            status_atendimento: 'aberta'
          })
          .select('id')
          .single()
        
        if (novaConversaError) {
          throw new Error(novaConversaError.message)
        }
        
        conversaId = novaConversa.id
      }
    }
    
    // Inserir mensagem de teste
    await supabase
      .from('mensagens')
      .insert({
        conversa_id: conversaId,
        texto,
        direcao: 'in',
        company_id: companyId,
        status: 'recebida'
      })
    
    // Simular processamento do chatbot
    const { processIncomingMessage } = require('../services/chatbotTriageService')
    
    const mockSendMessage = async (phone, message, opts) => {
      console.log(`[ChatbotSimulation] Enviando: ${message}`)
      return { ok: true, messageId: 'sim_' + Date.now() }
    }
    
    const result = await processIncomingMessage({
      company_id: companyId,
      conversa_id: conversaId,
      telefone,
      texto,
      supabase,
      sendMessage: mockSendMessage,
      opts: { companyId },
      conversaReabertaAposFinalizacao: reset
    })
    
    // Buscar mensagens e logs gerados
    const { data: mensagensGeradas } = await supabase
      .from('mensagens')
      .select('*')
      .eq('conversa_id', conversaId)
      .order('criado_em', { ascending: false })
      .limit(5)
    
    const { data: logsGerados } = await supabase
      .from('bot_logs')
      .select('*')
      .eq('conversa_id', conversaId)
      .order('criado_em', { ascending: false })
      .limit(5)
    
    res.json({
      success: true,
      data: {
        simulation_result: result,
        conversa_id: conversaId,
        cliente_id: clienteId,
        mensagens_geradas: mensagensGeradas,
        logs_gerados: logsGerados
      }
    })
  } catch (error) {
    console.error('[ChatbotDebug] Erro na simulação:', error.message)
    res.status(500).json({
      success: false,
      error: 'Erro na simulação do chatbot',
      details: error.message
    })
  }
})

/**
 * GET /api/chatbot/debug/metrics/:companyId
 * Métricas do chatbot para uma empresa
 */
router.get('/metrics/:companyId', async (req, res) => {
  try {
    const companyId = parseInt(req.params.companyId)
    const { periodo = '7d' } = req.query
    
    if (!companyId || isNaN(companyId)) {
      return res.status(400).json({
        success: false,
        error: 'ID da empresa inválido'
      })
    }
    
    // Calcular data de início baseada no período
    const now = new Date()
    const startDate = new Date()
    
    switch (periodo) {
      case '1d':
        startDate.setDate(now.getDate() - 1)
        break
      case '7d':
        startDate.setDate(now.getDate() - 7)
        break
      case '30d':
        startDate.setDate(now.getDate() - 30)
        break
      default:
        startDate.setDate(now.getDate() - 7)
    }
    
    // Buscar métricas dos logs
    const { data: logs, error: logsError } = await supabase
      .from('bot_logs')
      .select('tipo, criado_em, detalhes')
      .eq('company_id', companyId)
      .gte('criado_em', startDate.toISOString())
    
    if (logsError) {
      throw new Error(logsError.message)
    }
    
    // Calcular métricas
    const metrics = {
      periodo,
      total_interacoes: logs.length,
      menus_enviados: logs.filter(l => l.tipo === 'menu_enviado').length,
      opcoes_validas: logs.filter(l => l.tipo === 'opcao_valida').length,
      opcoes_invalidas: logs.filter(l => l.tipo === 'opcao_invalida').length,
      fora_horario: logs.filter(l => l.tipo === 'fora_horario').length,
      menu_reenviado: logs.filter(l => l.tipo === 'menu_reenviado').length,
      taxa_sucesso: 0,
      distribuicao_por_opcao: {},
      interacoes_por_dia: {}
    }
    
    // Taxa de sucesso
    if (metrics.menus_enviados > 0) {
      metrics.taxa_sucesso = ((metrics.opcoes_validas / metrics.menus_enviados) * 100).toFixed(2) + '%'
    }
    
    // Distribuição por opção
    logs.filter(l => l.tipo === 'opcao_valida').forEach(log => {
      const opcao = log.detalhes?.opcao_key || 'desconhecida'
      metrics.distribuicao_por_opcao[opcao] = (metrics.distribuicao_por_opcao[opcao] || 0) + 1
    })
    
    // Interações por dia
    logs.forEach(log => {
      const dia = log.criado_em.split('T')[0]
      metrics.interacoes_por_dia[dia] = (metrics.interacoes_por_dia[dia] || 0) + 1
    })
    
    res.json({
      success: true,
      data: metrics
    })
  } catch (error) {
    console.error('[ChatbotDebug] Erro ao buscar métricas:', error.message)
    res.status(500).json({
      success: false,
      error: 'Erro ao buscar métricas do chatbot',
      details: error.message
    })
  }
})

/**
 * POST /api/chatbot/debug/reset/:companyId
 * Reset completo do estado do chatbot para uma empresa
 */
router.post('/reset/:companyId', async (req, res) => {
  try {
    const companyId = parseInt(req.params.companyId)
    const { confirm = false } = req.body
    
    if (!companyId || isNaN(companyId)) {
      return res.status(400).json({
        success: false,
        error: 'ID da empresa inválido'
      })
    }
    
    if (!confirm) {
      return res.status(400).json({
        success: false,
        error: 'Confirmação necessária. Envie { "confirm": true } no body'
      })
    }
    
    // Limpar todos os logs do chatbot
    const { error: logsError } = await supabase
      .from('bot_logs')
      .delete()
      .eq('company_id', companyId)
    
    if (logsError) {
      throw new Error(`Erro ao limpar logs: ${logsError.message}`)
    }
    
    // Resetar conversas sem departamento (deixar como estavam antes do chatbot)
    const { error: conversasError } = await supabase
      .from('conversas')
      .update({
        departamento_id: null,
        atendente_id: null,
        status_atendimento: 'aberta'
      })
      .eq('company_id', companyId)
      .not('departamento_id', 'is', null)
    
    if (conversasError) {
      console.warn('Aviso ao resetar conversas:', conversasError.message)
    }
    
    res.json({
      success: true,
      message: `Estado do chatbot resetado com sucesso para empresa ${companyId}`
    })
  } catch (error) {
    console.error('[ChatbotDebug] Erro ao resetar chatbot:', error.message)
    res.status(500).json({
      success: false,
      error: 'Erro ao resetar chatbot',
      details: error.message
    })
  }
})

/**
 * GET /api/chatbot/debug/validate/:companyId
 * Valida configuração do chatbot para uma empresa
 */
router.get('/validate/:companyId', async (req, res) => {
  try {
    const companyId = parseInt(req.params.companyId)
    
    if (!companyId || isNaN(companyId)) {
      return res.status(400).json({
        success: false,
        error: 'ID da empresa inválido'
      })
    }
    
    const { getChatbotConfig } = require('../services/chatbotTriageService')
    
    // Buscar configuração
    const config = await getChatbotConfig(companyId)
    
    const validation = {
      company_id: companyId,
      config_exists: !!config,
      is_valid: false,
      errors: [],
      warnings: [],
      details: {}
    }
    
    if (!config) {
      validation.errors.push('Configuração não encontrada')
      return res.json({
        success: false,
        data: validation
      })
    }
    
    validation.details = {
      enabled: config.enabled,
      welcome_message: !!config.welcomeMessage,
      total_options: config.options?.length || 0,
      active_options: config.options?.filter(o => o.active !== false).length || 0,
      business_hours_configured: config.foraHorarioEnabled,
      reopen_command: config.reopenMenuCommand
    }
    
    // Validações
    if (!config.enabled) {
      validation.warnings.push('Chatbot está desativado')
    }
    
    if (!config.welcomeMessage) {
      validation.errors.push('Mensagem de boas-vindas não configurada')
    }
    
    if (!config.options || config.options.length === 0) {
      validation.errors.push('Nenhuma opção de menu configurada')
    } else {
      const activeOptions = config.options.filter(o => o.active !== false)
      if (activeOptions.length === 0) {
        validation.errors.push('Nenhuma opção ativa no menu')
      }
      
      // Verificar se todas as opções têm departamento válido
      for (const option of activeOptions) {
        if (!option.departamento_id) {
          validation.errors.push(`Opção "${option.label}" sem departamento configurado`)
        }
      }
    }
    
    if (!config.invalidOptionMessage) {
      validation.warnings.push('Mensagem de opção inválida não configurada')
    }
    
    if (!config.confirmSelectionMessage) {
      validation.warnings.push('Mensagem de confirmação não configurada')
    }
    
    validation.is_valid = validation.errors.length === 0
    
    res.json({
      success: true,
      data: validation
    })
  } catch (error) {
    console.error('[ChatbotDebug] Erro na validação:', error.message)
    res.status(500).json({
      success: false,
      error: 'Erro na validação do chatbot',
      details: error.message
    })
  }
})

module.exports = router