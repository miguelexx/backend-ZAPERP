# Certificação: Nome e Número dos Contatos

**Data:** 2025-03-08  
**Objetivo:** Garantir que número e nome dos contatos venham corretamente, sincronizados, e que sem nome use o número. Restringir a IA de atualizar nomes.

---

## 1. Fontes Permitidas para Atualizar `clientes.nome`

| Fonte | Origem | Prioridade |
|-------|--------|------------|
| **syncZapi** | GET /contacts Z-API (contatos salvos no celular) | Máxima |
| **senderName** | Webhook ReceivedCallback (perfil WhatsApp) | Alta |
| **chatName** | Webhook (nome do chat/grupo) | Média |
| **Fallback** | Telefone quando nome ausente | Sempre que vazio |

---

## 2. Restrição: IA NÃO Atualiza Nomes

Os seguintes serviços **não têm e não devem ter** permissão para atualizar `clientes.nome`:

| Serviço | O que faz | Atualiza clientes.nome? |
|---------|------------|--------------------------|
| **aiDashboardService** | IA do Dashboard (OpenAI) — responde perguntas | ❌ NÃO (apenas SELECT) |
| **chatbotTriageService** | Chatbot de triagem — roteia para setores | ❌ NÃO (atualiza conversas, não clientes) |
| **iaController** | Configuração de IA (chatbot_triage, regras) | ❌ NÃO |

**Apenas** os fluxos de sincronização Z-API e webhook podem atualizar nomes.

---

## 3. Regra: Sem Nome → Salvar com Número

Em todos os pontos onde criamos ou atualizamos clientes:

| Arquivo | Quando aplica |
|---------|---------------|
| `helpers/conversationSync.js` | getOrCreateCliente: UPDATE e INSERT usam telefone como fallback |
| `controllers/webhookZapiController.js` | Sync on connect: nomeFinal = nome \|\| phone |
| `controllers/chatController.js` | sincronizarContatosZapi: missingName → updates.nome = phone |
| `services/zapiSyncContact.js` | nome = name \|\| short \|\| notify \|\| vname \|\| phoneNorm |

---

## 4. Fluxo de Sincronização

### Webhook ReceivedCallback
1. Payload traz `senderName`, `chatName`, `name`, `short`, `notify`
2. `getOrCreateCliente` usa `chooseBestName` para evitar regressão
3. Se sem nome → `updates.nome = telefoneCanonico` ou dígitos

### Z-API GET /contacts (sync manual ou on connect)
1. Prioridade: `name` > `short` > `notify` > `vname`
2. Se ausente → `nome = phone`
3. chooseBestName evita substituir nome bom por pior

### zapiSyncContact (metadata por telefone)
1. Prioridade: name > short > notify > vname
2. Fallback: `phoneNorm` (dígitos do telefone)

---

## 5. Verificação

```sql
-- Contatos sem nome (deveriam ter número como fallback)
SELECT id, telefone, nome FROM clientes
WHERE company_id = 1 AND (nome IS NULL OR nome = '')
LIMIT 20;
```

Após as correções, novos contatos devem sempre ter `nome` preenchido (nome real ou número).

---

## 6. Arquivos Modificados

| Arquivo | Alteração |
|---------|-----------|
| `helpers/contactEnrichment.js` | Documentação: fontes permitidas e restrição IA |
| `helpers/conversationSync.js` | Fallback número no bloco legacy de getOrCreateCliente |
| `controllers/webhookZapiController.js` | Sync on connect: chooseBestName + fallback phone |
| `services/aiDashboardService.js` | Comentário: nunca atualiza clientes |
| `services/chatbotTriageService.js` | Comentário: nunca atualiza clientes.nome |
