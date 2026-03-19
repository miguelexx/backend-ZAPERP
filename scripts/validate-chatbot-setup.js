#!/usr/bin/env node

/**
 * Script de Validação de Setup do Chatbot
 * 
 * Este script valida se o setup do chatbot está correto para todas as empresas,
 * verificando configurações, dependências e integridade dos dados.
 * 
 * Uso:
 *   node scripts/validate-chatbot-setup.js [company_id] [--fix] [--detailed]
 * 
 * Opções:
 *   company_id  ID da empresa para validar (opcional, default: todas)
 *   --fix       Tenta corrigir problemas encontrados automaticamente
 *   --detailed  Mostra informações detalhadas de cada validação
 *   --help      Mostra esta ajuda
 */

const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })

const {
  getChatbotStatusForAllCompanies,
  configureChatbotForCompany,
  generateChatbotConfig
} = require('../services/chatbotAutoConfigService')

const { getChatbotConfig, validateChatbotConfig } = require('../services/chatbotTriageService')
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
${colorize('Script de Validação de Setup do Chatbot', 'bright')}

${colorize('Uso:', 'cyan')}
  node scripts/validate-chatbot-setup.js [company_id] [opções]

${colorize('Opções:', 'cyan')}
  company_id  ID da empresa para validar (opcional, default: todas)
  --fix       Tenta corrigir problemas encontrados automaticamente
  --detailed  Mostra informações detalhadas de cada validação
  --help      Mostra esta ajuda

${colorize('Exemplos:', 'cyan')}
  node scripts/validate-chatbot-setup.js
  node scripts/validate-chatbot-setup.js 1
  node scripts/validate-chatbot-setup.js --fix
  node scripts/validate-chatbot-setup.js 1 --detailed --fix

${colorize('Validações realizadas:', 'cyan')}
• Configuração básica do chatbot
• Integridade dos departamentos
• Consistência das opções do menu
• Validação das mensagens configuradas
• Verificação de horário comercial
• Teste de conectividade com banco de dados
• Verificação de logs e histórico
`)
}

class ChatbotValidator {
  constructor(options = {}) {
    this.options = {
      fix: options.fix || false,
      detailed: options.detailed || false
    }
    this.results = {
      companies: [],
      summary: {
        total: 0,
        valid: 0,
        invalid: 0,
        fixed: 0
      }
    }
  }

  log(message, level = 'info') {
    const colors = {
      info: 'cyan',
      success: 'green',
      warning: 'yellow',
      error: 'red',
      detail: 'blue'
    }
    
    if (level === 'detail' && !this.options.detailed) return
    
    console.log(colorize(message, colors[level] || 'cyan'))
  }

  async validateCompany(companyId) {
    this.log(`\n🔍 Validando empresa ${companyId}`, 'info')
    
    const validation = {
      companyId,
      valid: true,
      checks: [],
      errors: [],
      warnings: [],
      fixed: []
    }

    try {
      // 1. Verificar se empresa existe e está ativa
      const { data: empresa, error: empresaError } = await supabase
        .from('empresas')
        .select('id, nome, ativo')
        .eq('id', companyId)
        .single()

      if (empresaError || !empresa) {
        validation.valid = false
        validation.errors.push('Empresa não encontrada')
        return validation
      }

      if (!empresa.ativo) {
        validation.valid = false
        validation.errors.push('Empresa inativa')
        return validation
      }

      validation.companyName = empresa.nome
      this.log(`  📊 Empresa: ${empresa.nome}`, 'detail')

      // 2. Verificar configuração do chatbot
      this.log('  🔧 Verificando configuração do chatbot...', 'detail')
      
      const config = await getChatbotConfig(companyId)
      
      if (!config) {
        validation.errors.push('Configuração do chatbot não encontrada')
        
        if (this.options.fix) {
          this.log('  🔧 Tentando criar configuração...', 'warning')
          try {
            const success = await configureChatbotForCompany(companyId)
            if (success) {
              validation.fixed.push('Configuração criada automaticamente')
              this.log('  ✅ Configuração criada com sucesso', 'success')
            } else {
              validation.errors.push('Falha ao criar configuração automaticamente')
            }
          } catch (error) {
            validation.errors.push(`Erro ao criar configuração: ${error.message}`)
          }
        }
      } else {
        validation.checks.push('Configuração encontrada')
        
        // Validar estrutura da configuração
        const validatedConfig = validateChatbotConfig(config)
        if (!validatedConfig) {
          validation.errors.push('Configuração inválida')
        } else {
          validation.checks.push('Estrutura da configuração válida')
          
          // Verificar campos obrigatórios
          if (!validatedConfig.welcomeMessage) {
            validation.warnings.push('Mensagem de boas-vindas não configurada')
          }
          
          if (!validatedConfig.options || validatedConfig.options.length === 0) {
            validation.errors.push('Nenhuma opção de menu configurada')
          } else {
            const activeOptions = validatedConfig.options.filter(o => o.active !== false)
            if (activeOptions.length === 0) {
              validation.errors.push('Nenhuma opção ativa no menu')
            } else {
              validation.checks.push(`${activeOptions.length} opções ativas encontradas`)
            }
          }
        }
      }

      // 3. Verificar departamentos
      this.log('  🏢 Verificando departamentos...', 'detail')
      
      const { data: departamentos, error: deptError } = await supabase
        .from('departamentos')
        .select('id, nome')
        .eq('company_id', companyId)

      if (deptError) {
        validation.errors.push(`Erro ao buscar departamentos: ${deptError.message}`)
      } else {
        if (departamentos.length === 0) {
          validation.warnings.push('Nenhum departamento encontrado')
          
          if (this.options.fix) {
            this.log('  🔧 Criando departamentos padrão...', 'warning')
            try {
              const defaultDepts = ['Comercial', 'Suporte', 'Financeiro', 'Administrativo']
              
              for (const nome of defaultDepts) {
                await supabase
                  .from('departamentos')
                  .insert({
                    company_id: companyId,
                    nome
                  })
              }
              
              validation.fixed.push('Departamentos padrão criados')
              this.log('  ✅ Departamentos padrão criados', 'success')
            } catch (error) {
              validation.errors.push(`Erro ao criar departamentos: ${error.message}`)
            }
          }
        } else {
          validation.checks.push(`${departamentos.length} departamentos encontrados`)
          
          // Verificar se opções do chatbot correspondem aos departamentos
          if (config && config.options) {
            const configDeptIds = config.options
              .filter(o => o.active !== false)
              .map(o => o.departamento_id)
              .filter(Boolean)
            
            const existingDeptIds = departamentos.map(d => d.id)
            const invalidDeptIds = configDeptIds.filter(id => !existingDeptIds.includes(id))
            
            if (invalidDeptIds.length > 0) {
              validation.warnings.push(`Opções referenciam departamentos inexistentes: ${invalidDeptIds.join(', ')}`)
            } else {
              validation.checks.push('Todas as opções referenciam departamentos válidos')
            }
          }
        }
      }

      // 4. Verificar logs do bot
      this.log('  📝 Verificando logs do bot...', 'detail')
      
      const { data: logs, error: logsError } = await supabase
        .from('bot_logs')
        .select('id, tipo')
        .eq('company_id', companyId)
        .limit(10)

      if (logsError) {
        validation.warnings.push(`Erro ao verificar logs: ${logsError.message}`)
      } else {
        if (logs.length > 0) {
          validation.checks.push(`${logs.length} logs encontrados`)
        } else {
          validation.warnings.push('Nenhum log de bot encontrado (chatbot pode não ter sido usado ainda)')
        }
      }

      // 5. Verificar conversas de teste
      this.log('  💬 Verificando conversas...', 'detail')
      
      const { data: conversas, error: conversasError } = await supabase
        .from('conversas')
        .select('id, status_atendimento, departamento_id')
        .eq('company_id', companyId)
        .limit(5)

      if (conversasError) {
        validation.warnings.push(`Erro ao verificar conversas: ${conversasError.message}`)
      } else {
        validation.checks.push(`${conversas.length} conversas encontradas`)
      }

      // 6. Teste de conectividade
      this.log('  🔗 Testando conectividade...', 'detail')
      
      try {
        const testConfig = await generateChatbotConfig(companyId)
        if (testConfig && testConfig.chatbot_triage) {
          validation.checks.push('Geração de configuração funcionando')
        } else {
          validation.warnings.push('Problema na geração de configuração')
        }
      } catch (error) {
        validation.errors.push(`Erro no teste de conectividade: ${error.message}`)
      }

    } catch (error) {
      validation.valid = false
      validation.errors.push(`Erro geral na validação: ${error.message}`)
    }

    // Determinar se validação passou
    validation.valid = validation.errors.length === 0

    return validation
  }

  async validateAll() {
    this.log('🔍 Iniciando validação completa do setup do chatbot', 'info')
    
    try {
      const companies = await getChatbotStatusForAllCompanies()
      
      if (companies.length === 0) {
        this.log('❌ Nenhuma empresa encontrada', 'error')
        return this.results
      }

      this.results.summary.total = companies.length
      this.log(`📊 Validando ${companies.length} empresas...`, 'info')

      for (const company of companies) {
        const validation = await this.validateCompany(company.company_id)
        this.results.companies.push(validation)
        
        if (validation.valid) {
          this.results.summary.valid++
          this.log(`✅ Empresa ${company.company_id} - ${validation.companyName || 'N/A'}: VÁLIDA`, 'success')
        } else {
          this.results.summary.invalid++
          this.log(`❌ Empresa ${company.company_id} - ${validation.companyName || 'N/A'}: INVÁLIDA`, 'error')
        }
        
        if (validation.fixed.length > 0) {
          this.results.summary.fixed++
          this.log(`🔧 Correções aplicadas: ${validation.fixed.length}`, 'warning')
        }

        // Mostrar detalhes se solicitado
        if (this.options.detailed) {
          if (validation.checks.length > 0) {
            this.log(`  ✅ Verificações: ${validation.checks.join(', ')}`, 'detail')
          }
          if (validation.warnings.length > 0) {
            this.log(`  ⚠️  Avisos: ${validation.warnings.join(', ')}`, 'warning')
          }
          if (validation.errors.length > 0) {
            this.log(`  ❌ Erros: ${validation.errors.join(', ')}`, 'error')
          }
          if (validation.fixed.length > 0) {
            this.log(`  🔧 Corrigido: ${validation.fixed.join(', ')}`, 'success')
          }
        }
      }

    } catch (error) {
      this.log(`❌ Erro durante validação: ${error.message}`, 'error')
    }

    return this.results
  }

  showSummary() {
    const { summary } = this.results
    
    this.log('\n📊 Resumo da Validação', 'info')
    this.log('=' .repeat(40), 'cyan')
    
    this.log(`Total de empresas: ${colorize(summary.total, 'bright')}`)
    this.log(`Empresas válidas: ${colorize(summary.valid, summary.valid === summary.total ? 'green' : 'yellow')}`)
    this.log(`Empresas inválidas: ${colorize(summary.invalid, summary.invalid > 0 ? 'red' : 'green')}`)
    
    if (summary.fixed > 0) {
      this.log(`Empresas corrigidas: ${colorize(summary.fixed, 'yellow')}`)
    }
    
    const successRate = summary.total > 0 ? ((summary.valid / summary.total) * 100).toFixed(1) : 0
    this.log(`Taxa de sucesso: ${colorize(successRate + '%', successRate === '100.0' ? 'green' : 'yellow')}`)

    // Mostrar problemas mais comuns
    const allErrors = this.results.companies.flatMap(c => c.errors)
    const allWarnings = this.results.companies.flatMap(c => c.warnings)
    
    if (allErrors.length > 0) {
      this.log('\n❌ Erros mais comuns:', 'error')
      const errorCounts = {}
      allErrors.forEach(error => {
        errorCounts[error] = (errorCounts[error] || 0) + 1
      })
      Object.entries(errorCounts)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 5)
        .forEach(([error, count]) => {
          this.log(`  • ${error} (${count}x)`, 'error')
        })
    }

    if (allWarnings.length > 0) {
      this.log('\n⚠️  Avisos mais comuns:', 'warning')
      const warningCounts = {}
      allWarnings.forEach(warning => {
        warningCounts[warning] = (warningCounts[warning] || 0) + 1
      })
      Object.entries(warningCounts)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 5)
        .forEach(([warning, count]) => {
          this.log(`  • ${warning} (${count}x)`, 'warning')
        })
    }

    if (summary.invalid === 0) {
      this.log('\n🎉 Parabéns! Todas as empresas passaram na validação!', 'success')
    } else if (this.options.fix && summary.fixed > 0) {
      this.log('\n🔧 Algumas correções foram aplicadas. Execute novamente para verificar.', 'warning')
    } else if (summary.invalid > 0 && !this.options.fix) {
      this.log('\n💡 Use --fix para tentar corrigir problemas automaticamente.', 'info')
    }
  }
}

async function main() {
  const args = process.argv.slice(2)
  const help = args.includes('--help')
  const fix = args.includes('--fix')
  const detailed = args.includes('--detailed')
  
  const companyIdArg = args.find(arg => !arg.startsWith('--') && !isNaN(parseInt(arg)))
  const companyId = companyIdArg ? parseInt(companyIdArg) : null

  if (help) {
    showHelp()
    process.exit(0)
  }

  const validator = new ChatbotValidator({ fix, detailed })

  try {
    if (companyId) {
      console.log(colorize(`\n🔍 Validando empresa ${companyId}`, 'bright'))
      const validation = await validator.validateCompany(companyId)
      
      console.log(colorize('\n📊 Resultado da Validação', 'cyan'))
      console.log('=' .repeat(30))
      
      if (validation.valid) {
        console.log(colorize('✅ VALIDAÇÃO PASSOU', 'green'))
      } else {
        console.log(colorize('❌ VALIDAÇÃO FALHOU', 'red'))
      }
      
      if (validation.checks.length > 0) {
        console.log(colorize('\n✅ Verificações bem-sucedidas:', 'green'))
        validation.checks.forEach(check => console.log(`  • ${check}`))
      }
      
      if (validation.warnings.length > 0) {
        console.log(colorize('\n⚠️  Avisos:', 'yellow'))
        validation.warnings.forEach(warning => console.log(`  • ${warning}`))
      }
      
      if (validation.errors.length > 0) {
        console.log(colorize('\n❌ Erros:', 'red'))
        validation.errors.forEach(error => console.log(`  • ${error}`))
      }
      
      if (validation.fixed.length > 0) {
        console.log(colorize('\n🔧 Correções aplicadas:', 'cyan'))
        validation.fixed.forEach(fix => console.log(`  • ${fix}`))
      }
      
    } else {
      const results = await validator.validateAll()
      validator.showSummary()
    }

  } catch (error) {
    console.error(colorize(`\n❌ Erro durante validação: ${error.message}`, 'red'))
    process.exit(1)
  }
}

// Executar apenas se chamado diretamente
if (require.main === module) {
  main()
}

module.exports = { ChatbotValidator, main }