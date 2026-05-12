# Testes multi-tenant Z-API (curl)

## 0. Health do webhook

```bash
curl -s https://SEU_APP_URL/webhooks/zapi/health
# Esperado: {"ok":true}
```

## 1. GET /integrations/zapi/connect/status (ou /api/integrations/zapi/connect/status)

```bash
# Company 1 — deve retornar instância A (se empresa_zapi tem company_id=1)
curl -s -H "Authorization: Bearer JWT_USUARIO_EMPRESA_1" \
  "http://localhost:3000/api/integrations/zapi/connect/status"

# Esperado 200: { hasInstance: true|false, connected, smartphoneConnected, needsRestore, error, meSummary }
# Sem empresa_zapi: hasInstance:false
```

## 2. GET /chats/zapi-status (banner frontend)

```bash
curl -s -H "Authorization: Bearer JWT_USUARIO_EMPRESA_1" \
  "http://localhost:3000/api/chats/zapi-status"

# Esperado 200 (NUNCA 500): { ok, hasInstance, connected, configured }
```

## 3. Webhook mock (instanceId → company_id, SEM token)

**POST /webhooks/zapi NÃO exige token.** Validação via `instanceId` + `empresa_zapi`.

```bash
# Simula callback Z-API. instanceId deve existir em empresa_zapi.instance_id
INSTANCE_ID="seu_instance_id"  # ex: 3EE81ED189267279CB31EA4E62592653
curl -s -X POST "https://SEU_APP_URL/webhooks/zapi" \
  -H "Content-Type: application/json" \
  -d "{
    \"instanceId\": \"$INSTANCE_ID\",
    \"type\": \"ReceivedCallback\",
    \"phone\": \"5511999999999\",
    \"fromMe\": false,
    \"text\": {\"message\": \"teste\"},
    \"messageId\": \"test-123\"
  }"
```

Scripts de teste (sem token): `scripts/test-webhook-zapi-sem-token.sh` ou `.ps1`

Verifique no log do backend: `[Z-API-WEBHOOK]` com `instanceIdResolved` e `companyIdResolved`.

## 4. Webhook status mock

```bash
curl -s -X POST "http://localhost:3000/webhooks/zapi/status" \
  -H "Content-Type: application/json" \
  -d '{"instanceId":"INSTANCE_ID","ids":["msg_id"],"status":"READ"}'
```

## Pré-requisitos

- `empresa_zapi` com registros: (company_id, instance_id, instance_token, client_token, ativo=true)
- JWT com `company_id` no payload
- `instance_id` em empresa_zapi = `instanceId` enviado pelo Z-API no webhook
