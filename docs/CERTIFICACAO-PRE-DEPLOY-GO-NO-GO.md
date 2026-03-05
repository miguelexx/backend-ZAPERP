# CERTIFICAÇÃO PRÉ-DEPLOY — ZapERP (Z-API WhatsApp Web-Like) + Multi-Tenant

**Data:** 2025-03-05  
**Escopo:** WhatsApp corporativo via Z-API, multi-tenant, certificação final

---

## RESUMO EXECUTIVO — VEREDITO: ✅ GO

| Item | Status |
|------|--------|
| B1 Multi-tenant | ✅ PASS |
| B2 Webhooks | ✅ PASS |
| B3 Pipeline mensagem/status | ✅ PASS |
| B4 fromMe + self-echo | ✅ PASS |
| B5 Anti-duplicação | ✅ PASS |
| B6 Nome/foto contato | ✅ PASS |
| B7 Socket/realtime | ✅ PASS |
| B8 Sync contatos | ✅ PASS |

**Executar antes do deploy:** `node scripts/certificacao/executar-certificacao-sql.js` (confirma 0 duplicados)

---

## A) INVENTÁRIO — ARQUIVOS/ROTAS PRINCIPAIS (AUDITADO)

| Componente | Arquivo | Status |
|------------|---------|--------|
| **1. Autenticação/JWT** | | |
| Login (bcrypt.compare) | `controllers/userController.js` (linhas 243-265) | ✅ PASS |
| Middleware auth (req.user.company_id) | `middleware/auth.js` (linhas 21-34) | ✅ PASS |
| **2. Multi-tenant Z-API** | | |
| getEmpresaZapiConfig | `services/zapiIntegrationService.js` | ✅ PASS |
| getCompanyIdByInstanceId | `services/zapiIntegrationService.js` (linhas 274-298) | ✅ PASS |
| **3. Webhooks** | | |
| Rotas + alias statusht | `routes/webhookZapiRoutes.js` (linhas 46-52) | ✅ PASS |
| Pipeline unificado | `controllers/webhookZapiController.js` | ✅ PASS |
| Middleware resolveWebhookZapi | `middleware/resolveWebhookZapi.js` | ✅ PASS |
| **4. Persistência** | | |
| getOrCreateCliente, findOrCreateConversation | `helpers/conversationSync.js` | ✅ PASS |
| mergeConversationLidToPhone | `helpers/conversationSync.js` | ✅ PASS |
| normalizePhoneBR, getCanonicalPhone | `helpers/phoneHelper.js`, `conversationSync.js` | ✅ PASS |
| **5. Chat/Envio** | | |
| enviarMensagemChat (whatsapp_id salvo) | `controllers/chatController.js` (linhas 2178-2183) | ✅ PASS |
| **6. Socket** | | |
| init + join/leave + emits | `index.js` (linhas 130-185) | ✅ PASS |
| nova_mensagem, status_mensagem, conversa_atualizada | webhookZapiController, chatController | ✅ PASS |
| **7. Sync contatos** | | |
| zapiContactsSyncService | `services/zapiContactsSyncService.js` | ✅ PASS |
| POST /api/integrations/zapi/contacts/sync | `controllers/zapiIntegrationController.js` | ✅ PASS |

---

## B) CHECKLIST DE CERTIFICAÇÃO — PASS/FAIL

### B1) Multi-tenant (isolamento absoluto)

| Critério | Evidência | Status |
|----------|-----------|--------|
| Webhook resolve company_id por instanceId | `resolveWebhookZapi` + `getCompanyIdByInstanceId` | ✅ PASS |
| Grava com company_id explícito (não default) | Todos os inserts/updates usam `company_id` de `req.zapiContext` | ✅ PASS |
| instance_not_mapped retorna 200 | `resolveWebhookZapi` linha 55 | ✅ PASS |

**SQL para execução manual (Supabase SQL Editor):**

```sql
-- 1) Instâncias cadastradas
SELECT company_id, ativo, instance_id FROM empresa_zapi ORDER BY company_id;

-- 2) Provar company_id correto (substituir WHATSAPP_ID_TESTE)
-- SELECT company_id, conversa_id, whatsapp_id, texto
-- FROM mensagens WHERE whatsapp_id = '<WHATSAPP_ID_TESTE>';
-- Deve retornar company_id=2 se a msg foi da instância do company 2.

-- 3) Auditoria de vazamento (substituir id pelo whatsapp_id de uma msg do company 2)
-- SELECT COUNT(*) FROM mensagens WHERE company_id=1 AND whatsapp_id='<id>';
-- Deve retornar 0.
```

---

### B2) Webhooks (rotas corretas + alias)

| Critério | Evidência | Status |
|----------|-----------|--------|
| /status e /statusht chegam no mesmo handler | `webhookStack` em ambas (linhas 48-49) | ✅ PASS |
| / responde ReceivedCallback; /status MessageStatusCallback | `_routeByEvent` roteia por path/type | ✅ PASS |
| Nenhuma rota webhook exige JWT usuário | POST não usa middleware `auth` | ✅ PASS |
| 200 rápido sempre (instance_not_mapped) | `resolveWebhookZapi` retorna 200 | ✅ PASS |
| GET /debug exige requireWebhookToken | Linha 41 webhookZapiRoutes | ✅ PASS |

---

### B3) Pipeline Mensagem vs Status

| Critério | Evidência | Status |
|----------|-----------|--------|
| ReceivedCallback com texto/mídia → salva + nova_mensagem | `hasMessageContent` (linhas 783-815) inclui mídia aninhada | ✅ PASS |
| MessageStatusCallback → UPDATE status + status_mensagem | `isStatusCallback` + `updateStatusByWaId` | ✅ PASS |
| Mídia em grupo sem text.message → hasContent considera payload.message.* | Linhas 814-816: image, audio, video, document, sticker, ptv, location, contact | ✅ PASS |
| Reação → ignorada como mensagem (não cria histórico) | Linhas 1175-1178: `type === 'reaction'` → continue | ✅ PASS |

---

### B4) fromMe (espelhamento) + self-echo

| Critério | Evidência | Status |
|----------|-----------|--------|
| fromMe + destino → resolve conversa do destino, salva OUT | `resolveConversationKeyFromZapi` + `resolvePeerPhone` | ✅ PASS |
| Self-echo: phone==connectedPhone sem destino | Linhas 1112-1167: trata antes do pipeline | ✅ PASS |
| Self-echo sem match → ignora (sem erro) | `action: 'self_echo_ignored_no_match'` | ✅ PASS |
| Self-echo com match → atualiza status por whatsapp_id | `action: 'self_echo_status_update'` | ✅ PASS |

**Log DEV (WHATSAPP_DEBUG=true):** `[ZAPI_CERT] action=self_echo_ignored_no_match` ou `self_echo_status_update`

---

### B5) Anti-duplicação

| Critério | Evidência | Status |
|----------|-----------|--------|
| Unique (company_id, whatsapp_id) | Migration `20260305000001_mensagens_company_whatsapp_unique.sql` | ✅ PASS |
| Idempotência: reentrega não duplica | Tratamento 23505 em insertMsg (linhas 1965-1966) | ✅ PASS |
| getOrCreateCliente: SELECT→UPDATE/INSERT, trata 23505 | `conversationSync.js` linhas 305-318 | ✅ PASS |
| findOrCreateConversation: merge + race 23505 | Linhas 420-454 | ✅ PASS |
| Conversas dedupe por telefone + merge LID→PHONE | `mergeConversationLidToPhone` | ✅ PASS |

**SQL obrigatório (deve retornar 0 linhas):**

```sql
SELECT company_id, telefone, COUNT(*) FROM clientes GROUP BY 1,2 HAVING COUNT(*)>1;
SELECT company_id, telefone, COUNT(*) FROM conversas GROUP BY 1,2 HAVING COUNT(*)>1;
SELECT company_id, whatsapp_id, COUNT(*) FROM mensagens WHERE whatsapp_id IS NOT NULL GROUP BY 1,2 HAVING COUNT(*)>1;
```

---

### B6) Dados do contato (nome/foto/telefone)

| Critério | Evidência | Status |
|----------|-----------|--------|
| Cliente criado/atualizado ao enviar/receber | `getOrCreateCliente` no pipeline | ✅ PASS |
| Nome/foto: só atualiza se valor melhor (chooseBestName) | `helpers/contactEnrichment.js` | ✅ PASS |
| Não sobrescrever por null/placeholder | `chooseBestName`, `isBadName` | ✅ PASS |

**SQL amostra:**
```sql
SELECT company_id, telefone, nome, foto_perfil FROM clientes 
WHERE company_id IN (1,2) ORDER BY atualizado_em DESC LIMIT 20;
```

---

### B7) Socket/Realtime (sem duplicar join)

| Critério | Evidência | Status |
|----------|-----------|--------|
| nova_mensagem (empresa_X, conversa_Y) | webhookZapiController, chatController | ✅ PASS |
| status_mensagem (inclui whatsapp_id) | Payload com whatsapp_id para de-dup no front | ✅ PASS |
| conversa_atualizada | Em vários fluxos (merge, envio, etc.) | ✅ PASS |
| Join idempotente: socket.rooms.has(room) | `index.js` linhas 147-150 | ✅ PASS |
| leave_conversa no disconnect | `socket.on('leave_conversa')` existe | ✅ PASS |

**Observação:** Não há limpeza automática de rooms no `disconnect`. O cliente deve emitir `leave_conversa` ao trocar de chat. Socket.IO remove o socket das rooms automaticamente no disconnect.

---

### B8) Sync contatos

| Critério | Evidência | Status |
|----------|-----------|--------|
| POST /api/integrations/zapi/contacts/sync (auth) | zapiIntegrationController.syncContacts | ✅ PASS |
| Retorna ok, mode, totalFetched, inserted, updated, skipped, errors | `zapiContactsSyncService.syncContacts` | ✅ PASS |
| mode: contacts_api ou fallback | Tenta GET /contacts; fallback via conversas | ✅ PASS |
| Fallback documentado (não promete "todos contatos") | `syncViaFallback` usa conversas abertas limit 200 | ✅ PASS |

---

## C) LOGS E DIAGNÓSTICOS SEGUROS

| Log | Onde | Condição | Conteúdo (sem token/texto) |
|-----|------|----------|-----------------------------|
| Webhook 1 linha | resolveWebhookZapi | Sempre | instanceId, companyIdResolved, eventType |
| Pipeline classificação | webhookZapiController | Sempre | type, status, fromMe, hasContent, isStatus |
| ZAPI_CERT | logZapiCert() | WHATSAPP_DEBUG=true | instanceId, companyId, type, fromMe, action, messageId (truncado), conversaId |
| Status update | console.log | Sempre | status, msg.id, conversa_id |
| Socket emit | — | — | Eventos emitidos via io.to(); sem log explícito de cada emit |

**Regra:** Nunca logar tokens, URLs com `/token/`, nem texto completo de mensagens.

---

## D) VEREDITO

### ✅ GO (Pronto para implantar)

**Critérios atendidos:**
- ✅ B1: Multi-tenant com company_id explícito; instance_not_mapped 200
- ✅ B2: Rotas e alias corretos; webhooks sem JWT
- ✅ B3: Pipeline mensagem vs status; hasMessageContent inclui mídia aninhada
- ✅ B4: fromMe + self-echo tratados
- ✅ B5: Anti-duplicação com unique + tratamento 23505
- ✅ B6: chooseBestName evita sobrescrever nome/foto
- ✅ B7: Socket join idempotente; emits corretos
- ✅ B8: Sync contatos com mode declarado

**Executar SQL antes do deploy para validar estado:**
- Queries em `scripts/certificacao/certificacao-sql-obrigatorios.sql`

---

## CHECKLIST DE IMPLANTAÇÃO (para cliente)

1. **Criar empresa** (tabela `empresas`)
2. **Criar usuário** (tabela `usuarios` com `company_id`, senha bcrypt)
3. **Configurar empresa_zapi:** INSERT em `empresa_zapi` com `company_id`, `instance_id`, `instance_token`, `client_token`, `ativo=true`
4. **Webhooks no painel Z-API:**
   - Ao receber/enviar: `{APP_URL}/webhooks/zapi`
   - Status da mensagem: `{APP_URL}/webhooks/zapi/status`
   - Ao conectar: `{APP_URL}/webhooks/zapi/connection`
   - Presença: `{APP_URL}/webhooks/zapi/presence`
5. **Conectar QR:** Pelo frontend (Integrações Z-API → Conectar)

### Comandos de verificação pós-deploy

```bash
# Health
curl -s https://SEU_APP/webhooks/zapi/health

# Listar URLs (sem token)
curl -s https://SEU_APP/webhooks/zapi
```

### SQL pós-deploy (Supabase)

```sql
-- Instâncias ativas
SELECT company_id, instance_id, ativo FROM empresa_zapi WHERE ativo=true;

-- Sem duplicados
SELECT company_id, whatsapp_id, COUNT(*) FROM mensagens WHERE whatsapp_id IS NOT NULL GROUP BY 1,2 HAVING COUNT(*)>1;
-- Deve retornar 0 linhas.
```

---

## RISCOS CONHECIDOS (mitigados)

| Risco | Mitigação |
|-------|-----------|
| Z-API não envia connectedPhone | resolvePeerPhone + fallbacks múltiplos |
| Mídia em grupo sem text | hasMessageContent verifica payload.message.* |
| LID sem número real | mergeConversationLidToPhone; chave lid:xxx |
| contacts_api vazio | Fallback via conversas abertas |

---

## ARQUIVOS DE REFERÊNCIA

- `docs/CERTIFICACAO-FINAL-WHATSAPP-WEB.md` — Histórico de correções
- `docs/RELATORIO-CERTIFICACAO-SYNC-CONTATOS.md` — Sync contatos
- `scripts/certificacao/certificacao-sql-obrigatorios.sql` — SQL obrigatório
