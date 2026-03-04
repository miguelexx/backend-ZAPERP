# Patch: remoção de dependências ENV para Z-API multi-tenant

## Locais corrigidos

### 1. Rotas de status (evitar 500)

| Arquivo | Alteração |
|---------|-----------|
| `controllers/chatController.js` | `zapiStatus`: NUNCA retorna 500; sem empresa_zapi → `hasInstance:false` (200); contrato alinhado com `/connect/status` |
| `controllers/configController.js` | `getEmpresasWhatsapp`: retorna `[]` quando tabela não existe; 502 em vez de 500 genérico |

### 2. Webhooks (roteamento por instanceId)

| Arquivo | Alteração |
|---------|-----------|
| `controllers/webhookZapiController.js` | Aceita `instanceId`, `instance_id` ou `instance` no payload |
| `services/zapiIntegrationService.js` | `getCompanyIdByInstanceId`: fallback case-insensitive quando match exato falha |

### 3. ENV ainda usadas (apenas fallback DEV)

| Variável | Uso |
|----------|-----|
| `ZAPI_INSTANCE_ID` | `services/providers/zapi.js` — resolveConfig: fallback quando companyId ausente (só NODE_ENV!==production) |
| `ZAPI_TOKEN` | Idem |
| `ZAPI_CLIENT_TOKEN` | Idem |
| `WEBHOOK_COMPANY_ID` | `controllers/webhookController.js` — Meta API (não Z-API); fallback quando phoneNumberId não mapeia |

### 4. ENV obrigatórias (mantidas)

- `ZAPI_BASE_URL`
- `ZAPI_WEBHOOK_TOKEN`

### 5. Tabela empresa_zapi

- `company_id` (UNIQUE)
- `instance_id` — deve ser IGUAL ao `instanceId` enviado pela Z-API no webhook
- `instance_token`, `client_token`, `ativo`

## Fluxo correto

1. **Rotas autenticadas**: `req.user.company_id` → `getEmpresaZapiConfig(company_id)` → credenciais do banco
2. **Webhooks**: `body.instanceId` → `getCompanyIdByInstanceId()` → `company_id` para persistir
3. **Sem mapeamento**: 200 + log; nunca 500, nunca vazar tokens
