# Patch final: Webhook diagnóstico e correções

## Alterações

### 1. Log seguro nos webhooks

Todos os handlers (receberZapi, statusZapi, connectionZapi, presenceZapi) chamam `_logWebhookSafe()` no início:

```json
{"ts":"2025-03-05T12:00:00.000Z","received":true,"instanceIdResolved":"3EE81ED18926…","companyIdResolved":1,"eventType":"ReceivedCallback","path":"/webhooks/zapi","payloadKeys":["instanceId","type","phone","fromMe","text","messageId"]}
```

- `instanceIdResolved`: truncado (24 chars)
- `companyIdResolved`: número ou `"not_mapped"`
- `payloadKeys`: chaves do body (sem token/password)
- Sem tokens, URLs completas ou conteúdo sensível

### 2. GET /webhooks/zapi/health

- Sempre retorna 200 `{"ok":true}`
- Pode ser usada no painel Z-API para validar conectividade

### 3. zapi-status usa empresa_zapi diretamente

- Não usa mais `provider.getConnectionStatus`
- Chama `getEmpresaZapiConfig(company_id)` e `getStatus(company_id)` de `zapiIntegrationService`
- Sem empresa_zapi → 200 `{ hasInstance:false, connected:false, configured:false }`
- Com empresa_zapi → consulta Z-API /status e retorna connected/smartphoneConnected

### 4. Documentação

- `docs/CHECKLIST-WEBHOOKS-PAINEL-ZAPI.md` — URLs completas, exemplos por APP_URL
- `docs/TESTE-MULTI-TENANT-CURL.md` — atualizado com health e webhook
- Scripts: `scripts/test-webhook-zapi.sh` e `.ps1`

### 5. Campos instanceId

Handlers aceitam `instanceId`, `instance_id` ou `instance` no payload (compatibilidade).

## Locais modificados

| Arquivo | Alteração |
|---------|-----------|
| `controllers/webhookZapiController.js` | _logWebhookSafe(), instrumentação em todos os handlers, payloadKeys |
| `controllers/chatController.js` | zapiStatus usa getEmpresaZapiConfig + getStatus diretamente |
| `routes/webhookZapiRoutes.js` | GET /health |
| `docs/CHECKLIST-WEBHOOKS-PAINEL-ZAPI.md` | Novo |
| `docs/TESTE-MULTI-TENANT-CURL.md` | health + webhook |
| `scripts/test-webhook-zapi.sh` | Novo |
| `scripts/test-webhook-zapi.ps1` | Novo |

## Remover depois (logs temporários)

Para produção, pode reduzir o nível de log. Os `_logWebhookSafe` ajudam no diagnóstico; depois de validar, pode comentar ou condicionar a `WHATSAPP_DEBUG=true`.
