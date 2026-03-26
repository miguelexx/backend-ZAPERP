/**
 * Script de teste para funcionalidade de encaminhamento de mensagens
 * 
 * Uso: node scripts/test-encaminhamento.js
 */

const supabase = require('../config/supabase')

async function testarEncaminhamento() {
  console.log('🧪 Iniciando teste de encaminhamento...')
  
  try {
    // 1. Buscar uma empresa ativa
    const { data: empresas } = await supabase
      .from('empresas')
      .select('id, nome')
      .limit(1)
    
    if (!empresas?.length) {
      console.log('❌ Nenhuma empresa encontrada')
      return
    }
    
    const empresa = empresas[0]
    console.log(`📊 Empresa: ${empresa.nome} (ID: ${empresa.id})`)
    
    // 2. Buscar conversas da empresa
    const { data: conversas } = await supabase
      .from('conversas')
      .select('id, telefone, nome_contato_cache')
      .eq('company_id', empresa.id)
      .limit(5)
    
    if (!conversas?.length) {
      console.log('❌ Nenhuma conversa encontrada')
      return
    }
    
    console.log(`💬 Encontradas ${conversas.length} conversas`)
    conversas.forEach(conv => {
      console.log(`  - ${conv.nome_contato_cache || conv.telefone} (ID: ${conv.id})`)
    })
    
    // 3. Buscar mensagens com mídia
    const { data: mensagens } = await supabase
      .from('mensagens')
      .select('id, conversa_id, texto, tipo, url, nome_arquivo')
      .eq('company_id', empresa.id)
      .in('tipo', ['imagem', 'video', 'audio', 'voice', 'arquivo', 'sticker'])
      .not('url', 'is', null)
      .limit(10)
    
    console.log(`📎 Encontradas ${mensagens?.length || 0} mensagens com mídia`)
    
    if (mensagens?.length) {
      mensagens.forEach(msg => {
        console.log(`  - ${msg.tipo}: ${msg.nome_arquivo || msg.texto} (ID: ${msg.id})`)
      })
    }
    
    // 4. Buscar mensagens de texto
    const { data: textos } = await supabase
      .from('mensagens')
      .select('id, conversa_id, texto, tipo')
      .eq('company_id', empresa.id)
      .eq('tipo', 'texto')
      .not('texto', 'is', null)
      .limit(5)
    
    console.log(`📝 Encontradas ${textos?.length || 0} mensagens de texto`)
    
    if (textos?.length) {
      textos.forEach(msg => {
        const textoPreview = msg.texto.length > 50 ? msg.texto.substring(0, 50) + '...' : msg.texto
        console.log(`  - "${textoPreview}" (ID: ${msg.id})`)
      })
    }
    
    // 5. Verificar configuração do WhatsApp
    const { data: config } = await supabase
      .from('empresa_zapi')
      .select('instance_id, instance_token')
      .eq('company_id', empresa.id)
      .maybeSingle()
    
    if (config?.instance_id && config?.instance_token) {
      console.log('✅ Configuração WhatsApp encontrada')
      console.log(`   Instance ID: ${config.instance_id}`)
      console.log(`   Token: ${config.instance_token.substring(0, 10)}...`)
    } else {
      console.log('⚠️  Configuração WhatsApp não encontrada')
    }
    
    // 6. Verificar usuários
    const { data: usuarios } = await supabase
      .from('usuarios')
      .select('id, nome, email')
      .eq('company_id', empresa.id)
      .limit(3)
    
    console.log(`👥 Encontrados ${usuarios?.length || 0} usuários`)
    
    if (usuarios?.length) {
      usuarios.forEach(user => {
        console.log(`  - ${user.nome} (${user.email}) - ID: ${user.id}`)
      })
    }
    
    console.log('\n✅ Teste concluído! Dados disponíveis para encaminhamento.')
    console.log('\n📋 Para testar o encaminhamento via API:')
    console.log('POST /api/chats/{conversa_destino_id}/encaminhar')
    console.log('Body: { "mensagem_id": "123" }')
    
    if (conversas.length >= 2 && (mensagens?.length || textos?.length)) {
      const conversaOrigem = conversas[0]
      const conversaDestino = conversas[1]
      const mensagemTeste = mensagens?.[0] || textos?.[0]
      
      console.log('\n🎯 Exemplo de teste:')
      console.log(`Encaminhar mensagem ${mensagemTeste.id} da conversa ${conversaOrigem.id} para conversa ${conversaDestino.id}`)
      console.log(`curl -X POST http://localhost:3000/api/chats/${conversaDestino.id}/encaminhar \\`)
      console.log(`  -H "Content-Type: application/json" \\`)
      console.log(`  -H "Authorization: Bearer SEU_TOKEN" \\`)
      console.log(`  -d '{"mensagem_id": "${mensagemTeste.id}"}'`)
    }
    
  } catch (error) {
    console.error('❌ Erro no teste:', error.message)
  }
}

// Executar se chamado diretamente
if (require.main === module) {
  testarEncaminhamento()
    .then(() => process.exit(0))
    .catch(error => {
      console.error('Erro fatal:', error)
      process.exit(1)
    })
}

module.exports = { testarEncaminhamento }