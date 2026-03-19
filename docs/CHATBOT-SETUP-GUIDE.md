# 🤖 Guia Completo de Setup do Chatbot de Triagem

Este guia abrangente explica como configurar, gerenciar e manter o sistema de chatbot de triagem para todas as empresas da plataforma WhatsApp.

## 📋 Índice

1. [Visão Geral](#visão-geral)
2. [Configuração Inicial](#configuração-inicial)
3. [Configuração por Empresa](#configuração-por-empresa)
4. [Gerenciamento via API](#gerenciamento-via-api)
5. [Scripts de Automação](#scripts-de-automação)
6. [Monitoramento e Debug](#monitoramento-e-debug)
7. [Solução de Problemas](#solução-de-problemas)
8. [Manutenção](#manutenção)

## 🎯 Visão Geral

O sistema de chatbot de triagem é uma solução completa que:

- **Funciona para todas as empresas** automaticamente
- **Reinicia o processo** quando conversas são reabertas
- **Auto-configura** novas empresas
- **Escala** para qualquer número de clientes
- **Monitora** e **diagnostica** problemas automaticamente

### Funcionalidades Principais

✅ **Auto-configuração**: Novas empresas recebem chatbot automaticamente  
✅ **Triagem inteligente**: Direciona clientes para departamentos corretos  
✅ **Horário comercial**: Mensagens diferentes dentro/fora do horário  
✅ **Reinício automático**: Conversas reabertas reiniciam o processo  
✅ **Comando de reabertura**: Cliente pode digitar "0" para ver o menu novamente  
✅ **Validação contínua**: Sistema verifica e corrige problemas automaticamente  

## 🚀 Configuração Inicial

### 1. Configurar Todas as Empresas (Primeira Vez)

Execute o script SQL para configurar automaticamente todas as empresas:

```sql
-- Execute no Supabase SQL Editor
\i supabase/AUTO_CONFIGURE_CHATBOT_ALL_COMPANIES.sql
```

Ou use o script Node.js:

```bash
# Configurar todas as empresas
node scripts/setup-all-chatbots.js

# Forçar reconfiguração (sobrescreve existentes)
node scripts/setup-all-chatbots.js --force

# Modo dry-run (apenas simula)
node scripts/setup-all-chatbots.js --dry-run
```

### 2. Verificar Configuração

```bash
# Validar setup de todas as empresas
node scripts/validate-chatbot-setup.js

# Validar empresa específica
node scripts/validate-chatbot-setup.js 1

# Validar e corrigir problemas automaticamente
node scripts/validate-chatbot-setup.js --fix
```

### 3. Testar Funcionamento

```bash
# Testar todas as empresas
node scripts/test-chatbot.js --all

# Testar empresa específica
node scripts/test-chatbot.js 1

# Modo interativo para testes manuais
node scripts/test-chatbot.js 1 --interactive
```

## 🏢 Configuração por Empresa

### Estrutura da Configuração

Cada empresa tem uma configuração em `ia_config.config.chatbot_triage`:

```json
{
  "chatbot_triage": {
    "enabled": true,
    "welcomeMessage": "Olá! Seja bem-vindo(a) à Empresa X.\nPara direcionarmos seu atendimento, por favor escolha com qual setor deseja falar:",
    "invalidOptionMessage": "Opção inválida. Por favor, responda apenas com o número do setor desejado.",
    "confirmSelectionMessage": "Perfeito! Seu atendimento foi direcionado para o setor {{departamento}}. Em instantes nossa equipe dará continuidade.",
    "sendOnlyFirstTime": true,
    "fallbackToAI": false,
    "businessHoursOnly": false,
    "transferMode": "departamento",
    "tipo_distribuicao": "fila",
    "reopenMenuCommand": "0",
    "intervaloEnvioSegundos": 3,
    "foraHorarioEnabled": true,
    "horarioInicio": "09:00",
    "horarioFim": "18:00",
    "mensagemForaHorario": "Olá! Nosso horário de atendimento é de segunda a sexta, das 09h às 18h. Sua mensagem foi recebida e retornaremos no próximo dia útil. Obrigado!",
    "diasSemanaDesativados": [0, 6],
    "datasEspecificasFechadas": [],
    "enviarMensagemFinalizacao": false,
    "mensagemFinalizacao": "Atendimento finalizado com sucesso. Segue seu protocolo: {{protocolo}}.\nPor favor, informe uma nota entre 0 e 10 para avaliar o atendimento prestado.",
    "options": [
      {
        "key": "1",
        "label": "Comercial",
        "departamento_id": 1,
        "active": true,
        "tag_id": null
      },
      {
        "key": "2",
        "label": "Suporte",
        "departamento_id": 2,
        "active": true,
        "tag_id": null
      }
    ]
  }
}
```

### Parâmetros de Configuração

| Parâmetro | Tipo | Descrição |
|-----------|------|-----------|
| `enabled` | boolean | Ativa/desativa o chatbot |
| `welcomeMessage` | string | Mensagem de boas-vindas personalizada |
| `sendOnlyFirstTime` | boolean | Envia menu apenas na primeira mensagem |
| `reopenMenuCommand` | string | Comando para reabrir menu (padrão: "0") |
| `foraHorarioEnabled` | boolean | Ativa mensagem fora do horário |
| `horarioInicio` | string | Horário de início (formato HH:mm) |
| `horarioFim` | string | Horário de fim (formato HH:mm) |
| `diasSemanaDesativados` | array | Dias sem atendimento (0=dom, 6=sáb) |
| `tipo_distribuicao` | string | "fila", "round_robin" ou "menor_carga" |
| `intervaloEnvioSegundos` | number | Delay entre mensagens do bot |

## 🔧 Gerenciamento via API

### Endpoints Disponíveis

#### Status de Todas as Empresas
```http
GET /api/chatbot/status
```

Resposta:
```json
{
  "success": true,
  "data": {
    "total_companies": 5,
    "configured_companies": 5,
    "enabled_companies": 4,
    "companies": [
      {
        "company_id": 1,
        "company_name": "Empresa A",
        "chatbot_configured": true,
        "chatbot_enabled": true,
        "total_options": 4,
        "welcome_message_configured": true,
        "business_hours_enabled": true
      }
    ]
  }
}
```

#### Configurar Todas as Empresas
```http
POST /api/chatbot/configure-all
Content-Type: application/json

{
  "config": {
    "foraHorarioEnabled": true,
    "horarioInicio": "08:00",
    "horarioFim": "17:00"
  }
}
```

#### Configurar Empresa Específica
```http
POST /api/chatbot/configure/1
Content-Type: application/json

{
  "config": {
    "welcomeMessage": "Olá! Bem-vindo à nossa empresa personalizada!",
    "horarioInicio": "09:00",
    "horarioFim": "18:00"
  }
}
```

#### Ativar/Desativar Chatbot
```http
PUT /api/chatbot/toggle/1
Content-Type: application/json

{
  "enabled": true
}
```

#### Reconfigurar Empresa
```http
POST /api/chatbot/reconfigure/1
```

#### Health Check
```http
GET /api/chatbot/health
```

### Endpoints de Debug

#### Logs do Chatbot
```http
GET /api/chatbot/debug/logs/1?limit=50&tipo=menu_enviado
```

#### Debug de Conversa
```http
GET /api/chatbot/debug/conversation/123
```

#### Simular Interação
```http
POST /api/chatbot/debug/simulate/1
Content-Type: application/json

{
  "telefone": "5511999999999",
  "texto": "Olá",
  "reset": true
}
```

#### Métricas
```http
GET /api/chatbot/debug/metrics/1?periodo=7d
```

#### Validar Configuração
```http
GET /api/chatbot/debug/validate/1
```

## 📜 Scripts de Automação

### setup-all-chatbots.js

Configura chatbot para todas as empresas:

```bash
# Uso básico
node scripts/setup-all-chatbots.js

# Opções disponíveis
node scripts/setup-all-chatbots.js --force    # Reconfigura existentes
node scripts/setup-all-chatbots.js --dry-run  # Apenas simula
node scripts/setup-all-chatbots.js --help     # Mostra ajuda
```

### test-chatbot.js

Testa funcionamento do chatbot:

```bash
# Testar todas as empresas
node scripts/test-chatbot.js --all

# Testar empresa específica
node scripts/test-chatbot.js 1

# Modo interativo
node scripts/test-chatbot.js 1 --interactive

# Resetar antes do teste
node scripts/test-chatbot.js 1 --reset
```

### validate-chatbot-setup.js

Valida configuração e integridade:

```bash
# Validar todas as empresas
node scripts/validate-chatbot-setup.js

# Validar empresa específica
node scripts/validate-chatbot-setup.js 1

# Corrigir problemas automaticamente
node scripts/validate-chatbot-setup.js --fix

# Modo detalhado
node scripts/validate-chatbot-setup.js --detailed
```

## 🔍 Monitoramento e Debug

### Logs do Sistema

O chatbot gera logs detalhados em `bot_logs`:

- `menu_enviado`: Menu de boas-vindas enviado
- `opcao_valida`: Cliente selecionou opção válida
- `opcao_invalida`: Cliente enviou opção inválida
- `menu_reenviado`: Menu reenviado via comando "0"
- `fora_horario`: Mensagem enviada fora do horário

### Métricas Importantes

```bash
# Ver métricas de uma empresa
curl "http://localhost:3000/api/chatbot/debug/metrics/1?periodo=7d"
```

Métricas incluem:
- Total de interações
- Taxa de sucesso
- Distribuição por opção
- Interações por dia
- Mensagens fora do horário

### Dashboard de Monitoramento

Acesse via API para criar dashboards:

```javascript
// Exemplo de monitoramento em tempo real
const monitorChatbot = async () => {
  const response = await fetch('/api/chatbot/status')
  const data = await response.json()
  
  console.log(`Empresas configuradas: ${data.data.configured_companies}/${data.data.total_companies}`)
  console.log(`Taxa de configuração: ${(data.data.configured_companies/data.data.total_companies*100).toFixed(1)}%`)
}
```

## 🔧 Solução de Problemas

### Problema: Chatbot não responde

**Diagnóstico:**
```bash
# 1. Verificar se está configurado
node scripts/validate-chatbot-setup.js 1

# 2. Ver logs recentes
curl "http://localhost:3000/api/chatbot/debug/logs/1?limit=10"

# 3. Testar configuração
node scripts/test-chatbot.js 1
```

**Soluções:**
- Verificar se `enabled: true`
- Verificar se empresa tem departamentos ativos
- Verificar se não está fora do horário (se configurado)

### Problema: Menu não aparece em conversa reaberta

**Diagnóstico:**
```bash
# Simular reabertura
curl -X POST "http://localhost:3000/api/chatbot/debug/simulate/1" \
  -H "Content-Type: application/json" \
  -d '{"texto": "Olá", "reset": true}'
```

**Solução:**
O sistema já trata automaticamente conversas reabertas. Verifique se:
- `conversaReabertaAposFinalizacao` está sendo passado corretamente
- Logs do bot foram limpos na reabertura

### Problema: Opções não correspondem aos departamentos

**Diagnóstico:**
```bash
# Reconfigurar baseado nos departamentos atuais
node scripts/setup-all-chatbots.js --force
```

**Solução:**
```sql
-- Ou via SQL
SELECT reconfigure_company_chatbot(1);
```

### Problema: Performance lenta

**Verificações:**
- `intervaloEnvioSegundos` muito alto
- Muitas mensagens simultâneas
- Problemas de conectividade com Supabase

**Solução:**
```json
{
  "intervaloEnvioSegundos": 1  // Reduzir delay
}
```

## 🔄 Manutenção

### Rotina Diária

```bash
# 1. Verificar health do sistema
curl "http://localhost:3000/api/chatbot/health"

# 2. Validar configurações
node scripts/validate-chatbot-setup.js --fix

# 3. Ver métricas do dia anterior
curl "http://localhost:3000/api/chatbot/debug/metrics/1?periodo=1d"
```

### Rotina Semanal

```bash
# 1. Teste completo de todas as empresas
node scripts/test-chatbot.js --all

# 2. Limpeza de logs antigos (opcional)
# Via SQL ou API de debug
```

### Rotina Mensal

```bash
# 1. Reconfiguração completa (se necessário)
node scripts/setup-all-chatbots.js --force

# 2. Análise de métricas mensais
curl "http://localhost:3000/api/chatbot/debug/metrics/1?periodo=30d"
```

### Backup de Configurações

```sql
-- Backup das configurações
SELECT 
  company_id,
  config->'chatbot_triage' as chatbot_config,
  atualizado_em
FROM ia_config 
WHERE config->'chatbot_triage' IS NOT NULL;
```

### Atualizações do Sistema

Quando adicionar novas empresas:

1. **Automático**: O trigger já configura automaticamente
2. **Manual**: Use `POST /api/chatbot/configure/{company_id}`
3. **Verificação**: Execute `validate-chatbot-setup.js`

Quando alterar departamentos:

1. **Automático**: O middleware detecta e reconfigura
2. **Manual**: Use `POST /api/chatbot/reconfigure/{company_id}`

## 📞 Suporte

### Logs de Debug

Para investigar problemas:

```bash
# Ver logs detalhados de uma conversa
curl "http://localhost:3000/api/chatbot/debug/conversation/123"

# Simular interação problemática
node scripts/test-chatbot.js 1 --interactive
```

### Contatos de Suporte

- **Documentação**: Este arquivo
- **Scripts**: `/scripts/` directory
- **APIs**: `/routes/chatbotManagementRoutes.js`
- **Logs**: Supabase `bot_logs` table

### Comandos de Emergência

```bash
# Desativar chatbot de uma empresa rapidamente
curl -X PUT "http://localhost:3000/api/chatbot/toggle/1" \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}'

# Reset completo de uma empresa
curl -X POST "http://localhost:3000/api/chatbot/debug/reset/1" \
  -H "Content-Type: application/json" \
  -d '{"confirm": true}'
```

---

## 🎉 Conclusão

Este sistema de chatbot foi projetado para ser:

- ✅ **Completamente automático** para todas as empresas
- ✅ **Auto-reparável** com validações e correções automáticas  
- ✅ **Escalável** para qualquer número de clientes
- ✅ **Monitorável** com métricas e logs detalhados
- ✅ **Testável** com scripts automatizados
- ✅ **Configurável** via API e interface web

O sistema garante que **todas as suas empresas/clientes** tenham um chatbot funcional que reinicia automaticamente quando conversas são reabertas, proporcionando uma experiência consistente e profissional para todos os usuários finais.

Para dúvidas ou problemas, consulte a seção de [Solução de Problemas](#solução-de-problemas) ou execute os scripts de diagnóstico disponíveis.