#!/usr/bin/env node

/**
 * Script de Setup Automático de Chatbot para Todas as Empresas
 * 
 * Este script configura automaticamente o chatbot de triagem para todas
 * as empresas ativas do sistema.
 * 
 * Uso:
 *   node scripts/setup-all-chatbots.js [--force] [--dry-run]
 * 
 * Opções:
 *   --force    Reconfigura mesmo se já existir configuração
 *   --dry-run  Apenas simula, não faz alterações
 *   --help     Mostra esta ajuda
 */

const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })

const {
  configureAllCompaniesChatbot,
  getChatbotStatusForAllCompanies,
  reconfigureChatbotForCompany
} = require('../services/chatbotAutoConfigService')

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
${colorize('Setup Automático de Chatbot para Todas as Empresas', 'bright')}

${colorize('Uso:', 'cyan')}
  node scripts/setup-all-chatbots.js [opções]

${colorize('Opções:', 'cyan')}
  --force     Reconfigura mesmo se já existir configuração
  --dry-run   Apenas simula, não faz alterações reais
  --help      Mostra esta ajuda

${colorize('Exemplos:', 'cyan')}
  node scripts/setup-all-chatbots.js
  node scripts/setup-all-chatbots.js --force
  node scripts/setup-all-chatbots.js --dry-run

${colorize('Descrição:', 'cyan')}
Este script configura automaticamente o chatbot de triagem para todas
as empresas ativas do sistema, criando:

• Configuração padrão do chatbot
• Opções baseadas nos departamentos existentes
• Mensagens personalizadas por empresa
• Horário comercial e mensagens fora do horário
• Comando de reabertura do menu (0)

O script é seguro e não sobrescreve configurações existentes,
a menos que a opção --force seja usada.
`)
}

async function main() {
  const args = process.argv.slice(2)
  const force = args.includes('--force')
  const dryRun = args.includes('--dry-run')
  const help = args.includes('--help')

  if (help) {
    showHelp()
    process.exit(0)
  }

  console.log(colorize('\n🤖 Setup Automático de Chatbot para Todas as Empresas', 'bright'))
  console.log(colorize('=' .repeat(60), 'cyan'))

  if (dryRun) {
    console.log(colorize('\n⚠️  MODO DRY-RUN: Nenhuma alteração será feita', 'yellow'))
  }

  if (force) {
    console.log(colorize('\n⚡ MODO FORCE: Reconfigurando empresas existentes', 'yellow'))
  }

  try {
    // 1. Verificar status atual
    console.log(colorize('\n📊 Verificando status atual...', 'blue'))
    const currentStatus = await getChatbotStatusForAllCompanies()
    
    console.log(`\n${colorize('Status Atual:', 'cyan')}`)
    console.log(`• Total de empresas: ${colorize(currentStatus.length, 'bright')}`)
    console.log(`• Com chatbot configurado: ${colorize(currentStatus.filter(s => s.chatbot_configured).length, 'green')}`)
    console.log(`• Com chatbot ativo: ${colorize(currentStatus.filter(s => s.chatbot_enabled).length, 'green')}`)

    if (currentStatus.length === 0) {
      console.log(colorize('\n❌ Nenhuma empresa ativa encontrada!', 'red'))
      process.exit(1)
    }

    // Mostrar detalhes por empresa
    console.log(colorize('\n📋 Detalhes por empresa:', 'cyan'))
    currentStatus.forEach(company => {
      const status = company.chatbot_configured 
        ? (company.chatbot_enabled ? colorize('✅ ATIVO', 'green') : colorize('⚠️  CONFIGURADO', 'yellow'))
        : colorize('❌ NÃO CONFIGURADO', 'red')
      
      console.log(`  ${company.company_id.toString().padStart(3)} - ${company.company_name.padEnd(30)} ${status}`)
    })

    if (dryRun) {
      console.log(colorize('\n🔍 Simulação concluída. Use sem --dry-run para aplicar as alterações.', 'yellow'))
      process.exit(0)
    }

    // 2. Configurar empresas
    console.log(colorize('\n🚀 Iniciando configuração...', 'blue'))
    
    let result
    if (force) {
      // Modo force: reconfigurar todas
      console.log(colorize('Reconfigurando todas as empresas...', 'yellow'))
      
      const results = {
        success: true,
        configured: 0,
        failed: 0,
        companies: [],
        errors: []
      }

      for (const company of currentStatus) {
        try {
          console.log(`  Reconfigurando empresa ${company.company_id} - ${company.company_name}...`)
          const success = await reconfigureChatbotForCompany(company.company_id)
          
          if (success) {
            results.configured++
            results.companies.push({
              id: company.company_id,
              nome: company.company_name,
              status: 'reconfigured'
            })
            console.log(colorize(`    ✅ Sucesso`, 'green'))
          } else {
            results.failed++
            results.companies.push({
              id: company.company_id,
              nome: company.company_name,
              status: 'failed'
            })
            console.log(colorize(`    ❌ Falhou`, 'red'))
          }
        } catch (error) {
          results.failed++
          results.errors.push({
            company_id: company.company_id,
            company_name: company.company_name,
            error: error.message
          })
          console.log(colorize(`    ❌ Erro: ${error.message}`, 'red'))
        }
      }
      
      result = results
    } else {
      // Modo normal: configurar apenas as não configuradas
      result = await configureAllCompaniesChatbot()
    }

    // 3. Mostrar resultado
    console.log(colorize('\n📊 Resultado da Configuração:', 'cyan'))
    
    if (result.success) {
      console.log(colorize(`✅ Configuração concluída com sucesso!`, 'green'))
      console.log(`• Empresas configuradas: ${colorize(result.configured, 'green')}`)
      
      if (result.failed > 0) {
        console.log(`• Empresas com falha: ${colorize(result.failed, 'red')}`)
      }
      
      if (result.companies && result.companies.length > 0) {
        console.log(colorize('\n📋 Detalhes:', 'cyan'))
        result.companies.forEach(company => {
          const statusIcon = company.status === 'configured' || company.status === 'reconfigured' 
            ? colorize('✅', 'green') 
            : colorize('❌', 'red')
          
          console.log(`  ${statusIcon} ${company.id} - ${company.nome}`)
          
          if (company.error) {
            console.log(`      ${colorize('Erro:', 'red')} ${company.error}`)
          }
        })
      }

      if (result.errors && result.errors.length > 0) {
        console.log(colorize('\n❌ Erros encontrados:', 'red'))
        result.errors.forEach(error => {
          console.log(`  • ${error.company_name} (ID: ${error.company_id}): ${error.error}`)
        })
      }

    } else {
      console.log(colorize(`❌ Falha na configuração: ${result.error}`, 'red'))
      process.exit(1)
    }

    // 4. Verificar status final
    console.log(colorize('\n🔍 Verificando status final...', 'blue'))
    const finalStatus = await getChatbotStatusForAllCompanies()
    
    const finalConfigured = finalStatus.filter(s => s.chatbot_configured).length
    const finalEnabled = finalStatus.filter(s => s.chatbot_enabled).length
    
    console.log(`\n${colorize('Status Final:', 'cyan')}`)
    console.log(`• Total de empresas: ${colorize(finalStatus.length, 'bright')}`)
    console.log(`• Com chatbot configurado: ${colorize(finalConfigured, 'green')} (${((finalConfigured / finalStatus.length) * 100).toFixed(1)}%)`)
    console.log(`• Com chatbot ativo: ${colorize(finalEnabled, 'green')} (${finalConfigured > 0 ? ((finalEnabled / finalConfigured) * 100).toFixed(1) : 0}%)`)

    console.log(colorize('\n✅ Setup concluído com sucesso!', 'green'))
    console.log(colorize('\n💡 Próximos passos:', 'cyan'))
    console.log('  • Teste o chatbot enviando mensagens para as empresas')
    console.log('  • Use o comando "0" para reabrir o menu')
    console.log('  • Monitore os logs em /api/chatbot/debug/logs/:companyId')
    console.log('  • Verifique métricas em /api/chatbot/debug/metrics/:companyId')

  } catch (error) {
    console.error(colorize(`\n❌ Erro durante o setup: ${error.message}`, 'red'))
    console.error(colorize('Stack trace:', 'red'))
    console.error(error.stack)
    process.exit(1)
  }
}

// Executar apenas se chamado diretamente
if (require.main === module) {
  main()
}

module.exports = { main }