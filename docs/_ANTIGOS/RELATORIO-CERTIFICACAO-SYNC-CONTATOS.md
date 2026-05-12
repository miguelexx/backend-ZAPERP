# Relatório de Certificação: WhatsApp Web-like + Sync Contatos

## Checklist Backend — Evidências

### A) Login/JWT
| Item | Status | Evidência |
|------|--------|-----------|
| JWT sempre inclui company_id | ✅ PASS | `middleware/auth.js` linha 21-30: valida `decoded.company_id` e rejeita se inválido |
| Endpoints usam req.user.company_id | ✅ PASS | Todos os controllers Z-API/chat usam `req.user?.company_id` |
| Nunca company_id do client | ✅ PASS | Nenhum endpoint aceita company_id no body/query para operações multi-tenant |

### B) Webhook Z-API
| Item | Status | Evidência |
|------|--------|-----------|
| /webhooks/zapi, /status, /connection, /presence | ✅ PASS | `webhookZapiRoutes.js` — todas rotas usam webhookStack |
| Alias /statusht (typo painel) | ✅ PASS | `router.post('/statusht', webhookStack)` linha 51 |
| company_id por instanceId (case-insensitive) | ✅ PASS | `zapiIntegrationService.getCompanyIdByInstanceId`: eq exato + ilike fallback |
| Insert mensagem com company_id explícito | ✅ PASS | `webhookZapiController`: todos inserts usam `company_id` do `req.zapiContext` |

### C) Pipeline Mensagem vs Status
| Item | Status | Evidência |
|------|--------|-----------|
| ReceivedCallback → salvar + emit nova_mensagem | ✅ PASS | `receberZapi` → insert mensagens → `io.emit('nova_mensagem', ...)` |
| DeliveryCallback/MessageStatusCallback → status + status_mensagem | ✅ PASS | `statusZapi` → update status → `emit('status_mensagem', { whatsapp_id, ... })` |
| fromMe com destino → espelhar na conversa correta | ✅ PASS | `resolvePeerPhone` + `resolveConversationKeyFromZapi` prioriza `to`, `remoteJid` |
| Self-echo (phone==connectedPhone, sem dest) → status ou ignorar | ✅ PASS | Tratado em `receberZapi` — não cria conversa, não drop com erro |

### D) Anti-duplicação
| Item | Status | Evidência |
|------|--------|-----------|
| mensagens unique (company_id, whatsapp_id) | ✅ PASS | `idx_mensagens_company_whatsapp_id` migration |
| getOrCreateCliente (evita 23505) | ✅ PASS | `conversationSync.js` — SELECT → UPDATE/INSERT, retry em 23505 |
| clientes/conversas unique por telefone | ✅ PASS | `idx_clientes_company_telefone_unique` |

### E) Dados do contato
| Item | Status | Evidência |
|------|--------|-----------|
| Prioridade: senderName > chatName > pushname | ✅ PASS | `extractMessage` em webhookZapiController |
| Foto: photo > senderPhoto | ✅ PASS | `senderPhoto`, `chatPhoto` no extractMessage |
| Nunca sobrescrever com null | ✅ PASS | `cacheUpdates` só inclui se valor truthy |

---

## Sockets Realtime
| Evento | Rooms | Quando emitido |
|--------|-------|----------------|
| nova_mensagem | empresa_*, conversa_* | ReceivedCallback salva mensagem |
| status_mensagem | empresa_*, conversa_* | DeliveryCallback/MessageStatusCallback atualiza status |
| conversa_atualizada | empresa_* | Merge LID→PHONE, atualização de cache |
| atualizar_conversa | empresa_* | Nova mensagem, status |

---

## Sync Contatos (POST /api/integrations/zapi/contacts/sync)

| Item | Status | Evidência |
|------|--------|-----------|
| Endpoint autenticado | ✅ PASS | Rota em zapiIntegrationRoutes (usa auth) |
| company_id = req.user.company_id | ✅ PASS | `syncContacts` recebe de controller |
| API oficial GET /contacts | ✅ PASS | Provider zapi.js `getContacts(page, pageSize, opts)` |
| Fallback via conversas | ✅ PASS | `syncViaFallback`: conversas abertas → syncContactFromZapi |
| Resposta { ok, mode, totalFetched, inserted, updated, skipped, errors } | ✅ PASS | Contrato implementado |

**Nota:** A Z-API oferece endpoint oficial `GET /contacts?page=&pageSize=` (documentação: developer.z-api.io/contacts/get-contacts). O fallback é usado quando a API retorna vazio ou falha.

---

## SQL Prova (company_id correto)

```sql
-- Mensagem da empresa 2 deve ter company_id=2
SELECT id, company_id, conversa_id, whatsapp_id, LEFT(texto, 30)
FROM mensagens
WHERE company_id = 2
ORDER BY criado_em DESC
LIMIT 5;
```

---

## Como testar

1. **Webhooks simulados:** `./scripts/certificacao/test-webhooks-curl.sh BASE_URL INSTANCE_ID`
2. **Sync contatos:** `node scripts/certificacao/test-sync-contatos.js BASE_URL JWT_TOKEN`
3. **Auditoria duplicados:** executar `scripts/certificacao/auditoria-duplicados.sql` no Supabase

### Exemplo curl sync
```bash
curl -X POST "http://localhost:3000/api/integrations/zapi/contacts/sync" \
  -H "Authorization: Bearer SEU_JWT" \
  -H "Content-Type: application/json"
```
