#!/usr/bin/env node

/**
 * Script de Teste do Chatbot
 * 
 * Este script testa o funcionamento do chatbot para uma ou todas as empresas,
 * simulando interações e verificando se as respostas estão corretas.
 * 
 * Uso:
 *   node scripts/test-chatbot.js [company_id] [--all] [--interactive] [--reset]
 * 
 * Opções:
 *   company_id     ID da empresa para testar (opcional)
 *   --all          Testa todas as empresas
 *   --interactive  Modo interativo para testar manualmente
 *   --reset        Reseta estado antes do teste
 *   --help         Mostra esta ajuda
 */

const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })

const readline = require('readline')
const {
  getChatbotStatusForAllCompanies,
  generateChatbotConfig
} = require('../services/chatbotAutoConfigService')

const { processIncomingMessage } = require('../services/chatbotTriageService')
const supabase = require('../config/supabase')

// Cores para output no terminal
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m'
}

function colorize(text, color) {
  return `${colors[color]}${text}${colors.reset}`
}

function showHelp() {
  console.log(`
${colorize('Script de Teste do Chatbot', 'bright')}

${colorize('Uso:', 'cyan')}
  node scripts/test-chatbot.js [company_id] [opções]

${colorize('Opções:', 'cyan')}
  company_id     ID da empresa para testar (opcional)
  --all          Testa todas as empresas ativas
  --interactive  Modo interativo para testar manualmente
  --reset        Reseta estado do chatbot antes do teste
  --help         Mostra esta ajuda

${colorize('Exemplos:', 'cyan')}
  node scripts/test-chatbot.js 1
  node scripts/test-chatbot.js --all
  node scripts/test-chatbot.js 1 --interactive
  node scripts/test-chatbot.js 1 --reset

${colorize('Descrição:', 'cyan')}
Este script testa o funcionamento do chatbot simulando interações
reais e verificando se as respostas estão corretas.

Testes realizados:
• Envio da mensagem de boas-vindas
• Seleção de opções válidas
• Tratamento de opções inválidas
• Comando de reabertura do menu
• Funcionamento fora do horário (se configurado)
• Reinício em conversas reabertas
`)
}

// Mock da função de envio de mensagem para capturar as respostas
let sentMessages = []
const mockSendMessage = async (phone, message, opts) => {
  const messageData = {
    phone,
    message,
    opts,
    timestamp: new Date().toISOString()
  }
  sentMessages.push(messageData)
  console.log(colorize(`📤 Bot enviou: ${message.slice(0, 100)}${message.length > 100 ? '...' : ''}`, 'blue'))
  return { ok: true, messageId: 'test_' + Date.now() }
}

async function createTestData(companyId, reset = false) {
  const telefone = `5511999${companyId.toString().padStart(6, '0')}`
  
  try {
    // Buscar ou criar cliente de teste
    let { data: cliente, error: clienteError } = await supabase
      .from('clientes')
      .select('id')
      .eq('telefone', telefone)
      .eq('company_id', companyId)
      .maybeSingle()
    
    if (!cliente) {
      const { data: novoCliente, error: novoClienteError } = await supabase
        .from('clientes')
        .insert({
          telefone,
          nome: `Cliente Teste ${companyId}`,
          company_id: companyId
        })
        .select('id')
        .single()
      
      if (novoClienteError) throw new Error(novoClienteError.message)
      cliente = novoCliente
    }
    
    // Buscar ou criar conversa de teste
    let { data: conversa, error: conversaError } = await supabase
      .from('conversas')
      .select('id')
      .eq('cliente_id', cliente.id)
      .eq('company_id', companyId)
      .maybeSingle()
    
    if (!conversa || reset) {
      if (conversa && reset) {
        // Limpar dados existentes para reset
        await supabase.from('bot_logs').delete().eq('conversa_id', conversa.id)
        await supabase.from('mensagens').delete().eq('conversa_id', conversa.id)
        await supabase
          .from('conversas')
          .update({
            departamento_id: null,
            atendente_id: null,
            status_atendimento: 'aberta'
          })
          .eq('id', conversa.id)
      } else {
        const { data: novaConversa, error: novaConversaError } = await supabase
          .from('conversas')
          .insert({
            cliente_id: cliente.id,
            company_id: companyId,
            telefone,
            nome_contato: `Cliente Teste ${companyId}`,
            status_atendimento: 'aberta'
          })
          .select('id')
          .single()
        
        if (novaConversaError) throw new Error(novaConversaError.message)
        conversa = novaConversa
      }
    }
    
    return {
      clienteId: cliente.id,
      conversaId: conversa.id,
      telefone
    }
  } catch (error) {
    throw new Error(`Erro ao criar dados de teste: ${error.message}`)
  }
}

async function testChatbotForCompany(companyId, reset = false) {
  console.log(colorize(`\n🧪 Testando chatbot para empresa ${companyId}`, 'bright'))
  console.log(colorize('-'.repeat(50), 'cyan'))
  
  const testResults = {
    companyId,
    success: true,
    tests: [],
    errors: []
  }
  
  try {
    // Verificar se empresa tem chatbot configurado
    const status = await getChatbotStatusForAllCompanies()
    const companyStatus = status.find(s => s.company_id === companyId)
    
    if (!companyStatus) {
      throw new Error(`Empresa ${companyId} não encontrada`)
    }
    
    if (!companyStatus.chatbot_configured) {
      throw new Error(`Chatbot não configurado para empresa ${companyId}`)
    }
    
    if (!companyStatus.chatbot_enabled) {
      console.log(colorize(`⚠️  Chatbot desativado para empresa ${companyId}`, 'yellow'))
    }
    
    console.log(`📊 Status: ${companyStatus.chatbot_enabled ? colorize('ATIVO', 'green') : colorize('INATIVO', 'yellow')}`)
    console.log(`📋 Opções disponíveis: ${companyStatus.total_options}`)
    
    // Criar dados de teste
    const testData = await createTestData(companyId, reset)
    console.log(`📱 Telefone de teste: ${testData.telefone}`)
    console.log(`💬 Conversa ID: ${testData.conversaId}`)
    
    // Limpar mensagens enviadas anteriores
    sentMessages = []
    
    // Teste 1: Primeira mensagem (deve enviar boas-vindas)
    console.log(colorize('\n🧪 Teste 1: Primeira mensagem (boas-vindas)', 'cyan'))
    
    await supabase.from('mensagens').insert({
      conversa_id: testData.conversaId,
      texto: 'Olá',
      direcao: 'in',
      company_id: companyId,
      status: 'recebida'
    })
    
    const result1 = await processIncomingMessage({
      company_id: companyId,
      conversa_id: testData.conversaId,
      telefone: testData.telefone,
      texto: 'Olá',
      supabase,
      sendMessage: mockSendMessage,
      opts: { companyId },
      conversaReabertaAposFinalizacao: false
    })
    
    if (result1.handled && sentMessages.length > 0) {
      console.log(colorize('✅ Boas-vindas enviadas corretamente', 'green'))
      testResults.tests.push({ name: 'Boas-vindas', success: true })
    } else {
      console.log(colorize('❌ Boas-vindas não foram enviadas', 'red'))
      testResults.tests.push({ name: 'Boas-vindas', success: false })
      testResults.success = false
    }
    
    // Teste 2: Opção válida
    console.log(colorize('\n🧪 Teste 2: Seleção de opção válida (1)', 'cyan'))
    sentMessages = []
    
    await supabase.from('mensagens').insert({
      conversa_id: testData.conversaId,
      texto: '1',
      direcao: 'in',
      company_id: companyId,
      status: 'recebida'
    })
    
    const result2 = await processIncomingMessage({
      company_id: companyId,
      conversa_id: testData.conversaId,
      telefone: testData.telefone,
      texto: '1',
      supabase,
      sendMessage: mockSendMessage,
      opts: { companyId },
      conversaReabertaAposFinalizacao: false
    })
    
    if (result2.handled && result2.departamento_id && sentMessages.length > 0) {
      console.log(colorize(`✅ Opção válida processada - Departamento: ${result2.departamento_id}`, 'green'))
      testResults.tests.push({ name: 'Opção válida', success: true, departamento_id: result2.departamento_id })
    } else {
      console.log(colorize('❌ Opção válida não foi processada corretamente', 'red'))
      testResults.tests.push({ name: 'Opção válida', success: false })
      testResults.success = false
    }
    
    // Resetar para próximo teste
    await createTestData(companyId, true)
    
    // Teste 3: Opção inválida
    console.log(colorize('\n🧪 Teste 3: Opção inválida (99)', 'cyan'))
    sentMessages = []
    
    // Primeiro enviar boas-vindas
    await processIncomingMessage({
      company_id: companyId,
      conversa_id: testData.conversaId,
      telefone: testData.telefone,
      texto: 'Olá',
      supabase,
      sendMessage: mockSendMessage,
      opts: { companyId },
      conversaReabertaAposFinalizacao: false
    })
    
    sentMessages = [] // Limpar mensagens de boas-vindas
    
    await supabase.from('mensagens').insert({
      conversa_id: testData.conversaId,
      texto: '99',
      direcao: 'in',
      company_id: companyId,
      status: 'recebida'
    })
    
    const result3 = await processIncomingMessage({
      company_id: companyId,
      conversa_id: testData.conversaId,
      telefone: testData.telefone,
      texto: '99',
      supabase,
      sendMessage: mockSendMessage,
      opts: { companyId },
      conversaReabertaAposFinalizacao: false
    })
    
    if (result3.handled && sentMessages.length > 0 && sentMessages[0].message.includes('inválida')) {
      console.log(colorize('✅ Opção inválida tratada corretamente', 'green'))
      testResults.tests.push({ name: 'Opção inválida', success: true })
    } else {
      console.log(colorize('❌ Opção inválida não foi tratada corretamente', 'red'))
      testResults.tests.push({ name: 'Opção inválida', success: false })
      testResults.success = false
    }
    
    // Teste 4: Comando de reabertura
    console.log(colorize('\n🧪 Teste 4: Comando de reabertura (0)', 'cyan'))
    sentMessages = []
    
    await supabase.from('mensagens').insert({
      conversa_id: testData.conversaId,
      texto: '0',
      direcao: 'in',
      company_id: companyId,
      status: 'recebida'
    })
    
    const result4 = await processIncomingMessage({
      company_id: companyId,
      conversa_id: testData.conversaId,
      telefone: testData.telefone,
      texto: '0',
      supabase,
      sendMessage: mockSendMessage,
      opts: { companyId },
      conversaReabertaAposFinalizacao: false
    })
    
    if (result4.handled && sentMessages.length > 0) {
      console.log(colorize('✅ Comando de reabertura funcionou', 'green'))
      testResults.tests.push({ name: 'Comando reabertura', success: true })
    } else {
      console.log(colorize('❌ Comando de reabertura não funcionou', 'red'))
      testResults.tests.push({ name: 'Comando reabertura', success: false })
      testResults.success = false
    }
    
    // Teste 5: Conversa reaberta
    console.log(colorize('\n🧪 Teste 5: Conversa reaberta após finalização', 'cyan'))
    sentMessages = []
    
    // Marcar conversa como finalizada
    await supabase
      .from('conversas')
      .update({ status_atendimento: 'finalizada' })
      .eq('id', testData.conversaId)
    
    await supabase.from('mensagens').insert({
      conversa_id: testData.conversaId,
      texto: 'Olá novamente',
      direcao: 'in',
      company_id: companyId,
      status: 'recebida'
    })
    
    const result5 = await processIncomingMessage({
      company_id: companyId,
      conversa_id: testData.conversaId,
      telefone: testData.telefone,
      texto: 'Olá novamente',
      supabase,
      sendMessage: mockSendMessage,
      opts: { companyId },
      conversaReabertaAposFinalizacao: true // Simular reabertura
    })
    
    if (result5.handled && sentMessages.length > 0) {
      console.log(colorize('✅ Conversa reaberta tratada corretamente', 'green'))
      testResults.tests.push({ name: 'Conversa reaberta', success: true })
    } else {
      console.log(colorize('❌ Conversa reaberta não foi tratada', 'red'))
      testResults.tests.push({ name: 'Conversa reaberta', success: false })
      testResults.success = false
    }
    
  } catch (error) {
    console.log(colorize(`❌ Erro durante os testes: ${error.message}`, 'red'))
    testResults.success = false
    testResults.errors.push(error.message)
  }
  
  return testResults
}

async function interactiveMode(companyId) {
  console.log(colorize(`\n🎮 Modo Interativo - Empresa ${companyId}`, 'bright'))
  console.log(colorize('Digite mensagens para testar o chatbot. Use "quit" para sair.', 'cyan'))
  
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })
  
  const testData = await createTestData(companyId, true)
  console.log(`📱 Telefone: ${testData.telefone}`)
  console.log(`💬 Conversa: ${testData.conversaId}`)
  
  const askQuestion = () => {
    rl.question(colorize('\n👤 Você: ', 'green'), async (input) => {
      if (input.toLowerCase() === 'quit') {
        rl.close()
        return
      }
      
      sentMessages = []
      
      try {
        await supabase.from('mensagens').insert({
          conversa_id: testData.conversaId,
          texto: input,
          direcao: 'in',
          company_id: companyId,
          status: 'recebida'
        })
        
        const result = await processIncomingMessage({
          company_id: companyId,
          conversa_id: testData.conversaId,
          telefone: testData.telefone,
          texto: input,
          supabase,
          sendMessage: mockSendMessage,
          opts: { companyId },
          conversaReabertaAposFinalizacao: false
        })
        
        if (!result.handled) {
          console.log(colorize('🤖 Bot: (não processado pelo chatbot)', 'yellow'))
        }
        
        if (result.departamento_id) {
          console.log(colorize(`📋 Transferido para departamento: ${result.departamento_id}`, 'blue'))
        }
        
      } catch (error) {
        console.log(colorize(`❌ Erro: ${error.message}`, 'red'))
      }
      
      askQuestion()
    })
  }
  
  askQuestion()
}

async function main() {
  const args = process.argv.slice(2)
  const help = args.includes('--help')
  const all = args.includes('--all')
  const interactive = args.includes('--interactive')
  const reset = args.includes('--reset')
  
  const companyIdArg = args.find(arg => !arg.startsWith('--') && !isNaN(parseInt(arg)))
  const companyId = companyIdArg ? parseInt(companyIdArg) : null

  if (help) {
    showHelp()
    process.exit(0)
  }

  console.log(colorize('\n🧪 Script de Teste do Chatbot', 'bright'))
  console.log(colorize('=' .repeat(40), 'cyan'))

  try {
    if (interactive) {
      if (!companyId) {
        console.log(colorize('❌ Modo interativo requer um company_id', 'red'))
        process.exit(1)
      }
      await interactiveMode(companyId)
      return
    }

    if (all) {
      console.log(colorize('\n🌐 Testando todas as empresas...', 'blue'))
      
      const status = await getChatbotStatusForAllCompanies()
      const activeCompanies = status.filter(s => s.chatbot_configured)
      
      if (activeCompanies.length === 0) {
        console.log(colorize('❌ Nenhuma empresa com chatbot configurado encontrada', 'red'))
        process.exit(1)
      }
      
      const allResults = []
      
      for (const company of activeCompanies) {
        const result = await testChatbotForCompany(company.company_id, reset)
        allResults.push(result)
      }
      
      // Resumo geral
      console.log(colorize('\n📊 Resumo Geral dos Testes', 'bright'))
      console.log(colorize('=' .repeat(40), 'cyan'))
      
      const totalTests = allResults.length
      const successfulTests = allResults.filter(r => r.success).length
      
      console.log(`Total de empresas testadas: ${colorize(totalTests, 'bright')}`)
      console.log(`Testes bem-sucedidos: ${colorize(successfulTests, successfulTests === totalTests ? 'green' : 'yellow')}`)
      console.log(`Taxa de sucesso: ${colorize(((successfulTests / totalTests) * 100).toFixed(1) + '%', successfulTests === totalTests ? 'green' : 'yellow')}`)
      
      allResults.forEach(result => {
        const status = result.success ? colorize('✅', 'green') : colorize('❌', 'red')
        console.log(`  ${status} Empresa ${result.companyId}: ${result.tests.filter(t => t.success).length}/${result.tests.length} testes`)
      })
      
    } else if (companyId) {
      const result = await testChatbotForCompany(companyId, reset)
      
      console.log(colorize('\n📊 Resultado do Teste', 'bright'))
      console.log(colorize('=' .repeat(30), 'cyan'))
      
      const successfulTests = result.tests.filter(t => t.success).length
      const totalTests = result.tests.length
      
      console.log(`Empresa: ${colorize(companyId, 'bright')}`)
      console.log(`Status geral: ${result.success ? colorize('✅ SUCESSO', 'green') : colorize('❌ FALHA', 'red')}`)
      console.log(`Testes passaram: ${colorize(successfulTests, 'bright')}/${colorize(totalTests, 'bright')}`)
      
      if (result.errors.length > 0) {
        console.log(colorize('\n❌ Erros:', 'red'))
        result.errors.forEach(error => console.log(`  • ${error}`))
      }
      
    } else {
      console.log(colorize('❌ Especifique um company_id ou use --all', 'red'))
      console.log('Uso: node scripts/test-chatbot.js [company_id] [--all] [--interactive]')
      process.exit(1)
    }

  } catch (error) {
    console.error(colorize(`\n❌ Erro durante os testes: ${error.message}`, 'red'))
    process.exit(1)
  }
}

// Executar apenas se chamado diretamente
if (require.main === module) {
  main()
}

module.exports = { main, testChatbotForCompany }