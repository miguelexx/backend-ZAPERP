# Revisão Completa — Recebimento, Espelhamento, Dados de Contato, Setores e Rotas

**Data:** 2026-03-11  
**Status geral:** ✅ **FUNCIONA** — fluxos validados no código

---

## 1. RECEBIMENTO DE MENSAGENS ✅

### Fluxo

| Etapa | Arquivo | O que acontece |
|-------|---------|----------------|
| 1 | `app.js` | POST `/webhooks/zapi` e `/webhook/zapi` registrados com rate-limit (60 req/min) |
| 2 | `requireWebhookToken.js` | Valida token (header/query) ou fallback por `instanceId` em `empresa_zapi` |
| 3 | `resolveWebhookZapi.js` | Extrai `instanceId` → `getCompanyIdByInstanceId` → `company_id` |
| 4 | `webhookZapiController.handleWebhookZapi` | Roteia por `type`: ReceivedCallback, DeliveryCallback, MessageStatusCallback etc. |
| 5 | `conversationSync.findOrCreateConversation` | Resolve ou cria conversa por telefone/LID |
| 6 | Insert em `mensagens` | `company_id`, `conversa_id`, `texto`, `direcao`, `whatsapp_id`, `status` |
| 7 | Socket.IO | Emite `nova_mensagem` para `empresa_X`, `conversa_Y`, `departamento_Z` |

### Condições de falha

- `instanceId` não mapeado em `empresa_zapi` → 200 `{ ok: true, ignored: 'instance_not_mapped' }`
- Token ausente/inválido e `instanceId` não registrado → 401
- `phone` vazio em fromMe sem `to`/`remoteJid` → DROPPED (log)

---

## 2. ESPELHAMENTO (fromMe) ✅

### O que é

Mensagens **enviadas pelo celular** (WhatsApp Web conectado) que aparecem no CRM em tempo real.

### Requisito no painel Z-API

- **"Notificar as enviadas por mim também"** deve estar **ativada**
- URL "Ao enviar" = mesma do webhook principal: `{APP_URL}/webhooks/zapi?token=...`

### Fluxo no backend

| Etapa | O que acontece |
|-------|----------------|
| 1 | Z-API envia ReceivedCallback com `fromMe: true` |
| 2 | `resolvePeerPhone` usa **destino** (to, remoteJid, recipientPhone), nunca `connectedPhone` |
| 3 | `findOrCreateConversation` encontra conversa do contato que **recebeu** a mensagem |
| 4 | Insert em `mensagens` com `direcao: 'out'` |
| 5 | Emite `nova_mensagem` via Socket.IO |
| 6 | Frontend exibe na bolha do chat (upsert por `whatsapp_id`) |

### Self-echo e reconciliação

- **Self-echo:** fromMe com `phone = connectedPhone` e sem destino → só atualiza status ou ignora (não insert)
- **Reconciliação:** Se CRM já enviou e inseriu, webhook atualiza `whatsapp_id` e emite apenas `status_mensagem` (não `nova_mensagem`)

---

## 3. DADOS DE CONTATO (nome, número, foto) ✅

### Nome

| Fonte | Score | Onde aplica |
|-------|-------|-------------|
| `syncZapi` / `name` (contato no celular) | 110 | `chooseBestName` |
| `chatName` | 80 | Webhook |
| `nome_existente` | 70 | Não sobrescrever com pior |
| `senderName` / `pushname` | 60 | Perfil WhatsApp |

- **Conversas:** `nome_contato_cache` (quando LID ou antes do cliente)
- **Clientes:** `nome`, `pushname` via `getOrCreateCliente` e `syncContactFromZapi`
- **Prioridade na listagem:** `nome_contato_cache` > `clientes.nome` > `telefone`

### Número

- **Normalização:** `normalizePhoneBR`, `possiblePhonesBR` (12/13 dígitos BR)
- **LID:** Chave sintética `lid:XXXX` até merge com número real via `mergeConversationLidToPhone`
- **fromMe:** `resolvePeerPhone` prioriza `to`, `toPhone`, `recipientPhone`, `key.remoteJid`

### Foto de perfil

| Local | Como preenche |
|------|----------------|
| `conversas.foto_perfil_contato_cache` | Webhook: `senderPhoto`, `chatPhoto` em `extractMessage` |
| `clientes.foto_perfil` | `syncContactFromZapi` → Z-API `getProfilePicture` |
| Prioridade no header | `foto_perfil_contato_cache` > `clientes.foto_perfil` |

- **Regra crítica:** Nunca sobrescrever com vazio — evita contato sumir da lista

---

## 4. SETORES, FUNÇÕES E ROTAS ✅

### Setores (departamentos)

- **Tabela:** `departamentos`
- **Uso:** `conversas.departamento_id`, `usuarios.departamento_id`
- **Visibilidade:** Admin vê tudo; supervisor/atendente veem só seu departamento e conversas sem setor
- **Rotas:** `GET/POST/PUT/DELETE /dashboard/departamentos` (adminOnly para criar/editar/excluir)
- **Transferência:** `PUT /chats/:id/departamento` (adminOnly)

### Funções (perfis)

| Perfil | Descrição |
|--------|-----------|
| `admin` | Todas as permissões |
| `supervisor` | config, ia, dashboard, integracoes, departamentos_ver |
| `atendente` | clientes, atendimentos (chats) |

- **Arquivo:** `helpers/permissoesCatalogo.js` — 40+ permissões granulares

### Rotas principais

| Prefixo | Uso |
|--------|-----|
| `/chats` | Listar, detalhar, enviar mensagem, assumir, encerrar, tags, transferir setor |
| `/clientes` | CRUD, tags |
| `/tags` | CRUD (adminOnly) |
| `/webhooks/zapi` | Webhook Z-API (mensagens, status, connection, presence) |
| `/integrations/zapi` | Integração Z-API, sync contatos |
| `/dashboard` | Métricas, departamentos |
| `/config` | Configurações da empresa |
| `/usuarios` | Usuários e autenticação |

---

## 5. CHECKLIST DE VERIFICAÇÃO RÁPIDA

Use este checklist para confirmar em produção:

- [ ] **Recebimento:** Cliente envia "oi" → mensagem aparece no chat em tempo real
- [ ] **Espelhamento:** Enviar do celular para um contato → mensagem aparece no CRM
- [ ] **Nome:** Contato com nome salvo no celular → nome aparece no header/listagem
- [ ] **Número:** Telefone normalizado (55 + DDD + número) na conversa
- [ ] **Foto:** Foto de perfil visível no header da conversa (quando disponível)
- [ ] **Setores:** Admin vê todos; atendente vê só seu departamento
- [ ] **Status (ticks):** Mensagem enviada → ✓ cinza → ✓✓ após entrega (webhook /status)

---

## 6. ARQUIVOS CRÍTICOS

| Arquivo | Responsabilidade |
|---------|------------------|
| `middleware/requireWebhookToken.js` | Token ou fallback instanceId |
| `middleware/resolveWebhookZapi.js` | instanceId → company_id |
| `controllers/webhookZapiController.js` | Pipeline de mensagens, emit socket |
| `helpers/conversationSync.js` | findOrCreateConversation, getOrCreateCliente |
| `helpers/conversationKeyHelper.js` | resolvePeerPhone (fromMe) |
| `helpers/contactEnrichment.js` | chooseBestName |
| `helpers/phoneHelper.js` | normalizePhoneBR, possiblePhonesBR |
| `services/zapiSyncContact.js` | syncContactFromZapi, foto de perfil |
| `controllers/chatController.js` | detalharChat, listarChats, nome_contato_cache |

---

## 7. DOCUMENTOS RELACIONADOS

- `CERTIFICACAO-WHATSAPP-WEB.md` — Fluxo completo e testes
- `CHECKLIST-WEBHOOKS-PAINEL-ZAPI.md` — URLs no painel Z-API
- `REVISAO-REALTIME-ENVIO-RECEBIMENTO.md` — Socket e enriquecimento
- `FRONTEND-ESPELHAMENTO-SOCKET.md` — Frontend: nova_mensagem e upsert

---

## 8. SCRIPTS DE CERTIFICAÇÃO

| Script | Uso |
|--------|-----|
| `node scripts/certificacao/verificar-sistema.js [URL]` | Verifica health, Supabase, webhooks e rotas |
| `./scripts/certificacao/test-webhooks-curl.sh BASE_URL INSTANCE_ID` | Simula webhooks (ReceivedCallback, fromMe, status). Use `export ZAPI_WEBHOOK_TOKEN=xxx` se necessário |
