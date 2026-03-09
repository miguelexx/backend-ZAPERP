# Relatório de Homologação — Backend do Chatbot de Triagem ZapERP

**Data:** 06/03/2025  
**Escopo:** Z-API apenas | Multi-tenant | chatbot_triage  
**Status:** Implementação concluída | Pendente de validação ponta a ponta

---

## 1. Configuração oficial

| Requisito | Status | Implementação |
|-----------|--------|---------------|
| GET /api/ia/config | ✅ | `iaController.getConfig` — retorna `chatbot_triage` mesclado |
| PUT /api/ia/config | ✅ | `iaController.putConfig` — salva `chatbot_triage` |
| Objeto chatbot_triage | ✅ | `ia_config.config.chatbot_triage` (JSONB) |
| enabled | ✅ | Boolean |
| welcomeMessage | ✅ | String |
| invalidOptionMessage | ✅ | String |
| confirmSelectionMessage | ✅ | String com suporte a `{{departamento}}` |
| sendOnlyFirstTime | ✅ | Boolean |
| fallbackToAI | ✅ | Boolean (estrutura pronta) |
| businessHoursOnly | ✅ | Boolean (estrutura pronta) |
| transferMode | ✅ | String ('departamento') |
| tipo_distribuicao | ✅ | String ('fila' \| 'round_robin' \| 'menor_carga') — fila = primeiro a assumir |
| reopenMenuCommand | ✅ | String (ex: "0") |
| options | ✅ | Array |
| options[].key | ✅ | String (ex: "1", "2") |
| options[].label | ✅ | String |
| options[].departamento_id | ✅ | Number |
| options[].active | ✅ | Boolean |

**Arquivos:** `controllers/iaController.js`, `services/chatbotTriageService.js`

---

## 2. Fluxo do webhook

| Requisito | Status | Implementação |
|-----------|--------|---------------|
| Identificar empresa | ✅ | `resolveWebhookZapi` → `getCompanyIdByInstanceId(instanceId)` → `empresa_zapi` |
| Identificar conversa | ✅ | `findOrCreateConversation` por telefone/LID |
| Verificar chatbot_triage.enabled | ✅ | `getChatbotConfig` → `config.enabled` |
| Conversa não roteada | ✅ | Condição `departamento_id == null` |
| Enviar menu | ✅ | `processIncomingMessage` → `buildWelcomeMessage` → `sendMessage` |
| Aguardar resposta | ✅ | Fluxo: mensagem → processIncomingMessage |
| Número válido → aplicar departamento | ✅ | `findOptionByKey` → `transferToDepartment` |
| Resposta inválida → erro + reenviar menu | ✅ | `invalidOptionMessage` + `menuOnly` |

**Arquivos:** `controllers/webhookZapiController.js` (linhas 1559-1583), `services/chatbotTriageService.js`

**Condições do chatbot:** `!fromMe && !isGroup && departamento_id == null && phone`

---

## 3. Transferência automática por departamento

| Requisito | Status | Implementação |
|-----------|--------|---------------|
| Encontrar departamento_id da opção | ✅ | `option.departamento_id` |
| Atualizar conversa | ✅ | `conversas.departamento_id`, `atendente_id`, `status_atendimento` |
| Registrar status da rota | ✅ | `atendimentos` com acao='transferiu' |
| Encaminhar para usuários do setor | ✅ | `usuarios` com `departamento_id` e `ativo=true` |
| Respeitar company_id | ✅ | Todas as queries filtram por `company_id` |
| Apenas usuários ativos | ✅ | `.eq('ativo', true)` |
| Registrar em log | ✅ | `logBotAction('opcao_valida', {...})` |
| Distribuição | ✅ | fila (primeiro a assumir), round_robin ou menor_carga |

**Arquivo:** `services/chatbotTriageService.js` — `transferToDepartment`

---

## 4. Confirmação ao cliente

| Requisito | Status | Implementação |
|-----------|--------|---------------|
| Enviar mensagem de confirmação | ✅ | `sendMessage(telefone, msgToSend, opts)` |
| Substituir {{departamento}} | ✅ | `replace(/\{\{departamento\}\}/gi, nomeSetor)` |
| Nome real do setor | ✅ | `nomeSetor = result.departamento_nome || option.label` (DB primeiro) |

**Arquivo:** `services/chatbotTriageService.js` — linhas 295-298

---

## 5. Logs

| Requisito | Status | Implementação |
|-----------|--------|---------------|
| GET /api/ia/logs | ✅ | `iaController.getLogs` |
| menu_enviado | ✅ | `logBotAction(..., 'menu_enviado', {...})` |
| opcao_valida | ✅ | `logBotAction(..., 'opcao_valida', {...})` |
| opcao_invalida | ✅ | `logBotAction(..., 'opcao_invalida', {...})` |
| menu_reenviado | ✅ | `logBotAction(..., 'menu_reenviado', {...})` |
| conversa_id nos logs | ✅ | `bot_logs.conversa_id` |
| company_id | ✅ | Filtro por `company_id` |

**Arquivos:** `controllers/iaController.js`, `services/chatbotTriageService.js`

---

## 6. Robustez obrigatória

| Requisito | Status | Implementação |
|-----------|--------|---------------|
| Multiempresa | ✅ | `company_id` em todas as queries e logs |
| Z-API apenas | ✅ | `zapiProvider.sendText` direto no webhook Z-API |
| Não processar mensagens do sistema | ✅ | Condição `!fromMe` — mensagens enviadas pelo sistema são ignoradas no fluxo do chatbot |
| Não reenviar menu infinitamente | ✅ | `sendOnlyFirstTime` + `wasMenuSentForConversa` — menu reenviado apenas em opção inválida ou comando de reabrir |
| Preservar integração com IA existente | ✅ | O chatbot atua antes dos fluxos de IA quando a conversa ainda não possui departamento definido; IA (ai/ask) permanece independente |
| Priorizar chatbot até escolher setor | ✅ | Chatbot executa antes de qualquer outro fluxo quando `departamento_id == null` |
| Tratamento de erros e salvaguardas | ✅ | Try/catch, logs de erro, mecanismo de prevenção de duplicidade baseado em `whatsapp_id` — sujeito à validação em fluxo real |

---

## 7. Rotas montadas

```
GET  /api/ia/config   → iaController.getConfig
PUT  /api/ia/config   → iaController.putConfig
GET  /api/ia/logs     → iaController.getLogs
```

**Arquivo:** `routes/iaRoutes.js`, `app.js`

---

## 8. Pré-requisitos de infraestrutura

- **empresa_zapi:** `instance_id` do payload deve existir na tabela para resolver `company_id`
- **departamentos:** Cadastrados em `dashboard/departamentos`
- **usuarios:** Com `departamento_id` e `ativo=true` para receber conversas
- **WHATSAPP_PROVIDER:** `zapi` (default no `providers/index.js`)

---

## 9. Checklist de teste manual (obrigatório para certificação final)

A certificação final do módulo depende da execução e aprovação deste checklist em ambiente real com Z-API conectada.

| # | Teste | Resultado |
|---|-------|-----------|
| 1 | Configurar chatbot em PUT /api/ia/config com `enabled: true` e opções válidas | [ ] |
| 2 | Enviar mensagem do WhatsApp para o número conectado (Z-API) | [ ] |
| 3 | Verificar recebimento do menu de boas-vindas | [ ] |
| 4 | Responder com número válido (ex: 1) | [ ] |
| 5 | Verificar confirmação com nome do setor ({{departamento}} substituído) | [ ] |
| 6 | Verificar conversa vinculada ao departamento e visível para usuários do setor | [ ] |
| 7 | Responder com opção inválida (ex: "abc") — deve receber mensagem de erro + menu | [ ] |
| 8 | Verificar GET /api/ia/logs com eventos corretos (menu_enviado, opcao_valida, opcao_invalida) | [ ] |
| 9 | Testar comando de reabrir menu (ex: "0") — deve reenviar o menu | [ ] |
| 10 | Validar ausência de loops (menu não reenviado indefinidamente) | [ ] |

---

## 10. Conclusão

**Implementação:** O backend do chatbot de triagem está implementado e aderente aos requisitos especificados. A estrutura de código, rotas, serviços e integração com o webhook Z-API foi concluída.

**Aderência técnica:** Os requisitos funcionais (configuração, fluxo do webhook, transferência por departamento, confirmação ao cliente, logs e robustez) foram atendidos na implementação, conforme descrito nas seções 1 a 6.

**Validação final:** A homologação definitiva do módulo está condicionada à execução do checklist manual (seção 9) em ambiente real com Z-API. Apenas após a aprovação de todos os itens desse checklist pode-se considerar o backend certificado para uso em produção.

**Resumo executivo:** Backend pronto para homologação. Estrutura concluída, pendente de teste ponta a ponta em cenário real com Z-API para validação final.
