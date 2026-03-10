# Checklist — Fluxo Conectar WhatsApp (Z-API)

## Rotas

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/integrations/zapi/connect/status` | Status + meSummary (sem tokens) |
| POST | `/api/integrations/zapi/connect/qrcode` | QR base64 com guard |
| GET | `/api/integrations/zapi/connect/qrcode` | Idem |
| POST | `/api/integrations/zapi/connect/restart` | Reinicia instância |
| POST | `/api/integrations/zapi/connect/phone-code` | Código de telefone (10-13 dígitos BR) |

## Segurança multi-tenant

- [x] `company_id` apenas de `req.user.company_id` (JWT)
- [x] Credenciais Z-API **sempre** de `empresa_zapi` ( nunca ENV para rotas autenticadas)
- [x] Webhooks: `company_id` por `instanceId` do payload (empresa_zapi)
- [x] Queries em `empresa_zapi` e `zapi_connect_guard` filtram por `company_id`
- [x] Nenhum token em responses, logs ou erros
- [x] URL com `/token/` nunca logada

Ver: [docs/ZAPI-MULTI-TENANT.md](./ZAPI-MULTI-TENANT.md)

## Guard / throttle / bloqueio

- [x] Throttle 15s entre chamadas de QR (anti-bloqueio: reconexões rápidas acionam detecção)
- [x] Bloqueio 90s após 3 tentativas sem conectar
- [x] 429 com `retryAfterSeconds` quando throttle/bloqueio
- [x] `resetOnConnected` quando `connected=true` (em status e qrcode)

## Tratamento de status

- [x] `needsRestore: true` quando "You need to restore the session."
- [x] `/connect/qrcode` retorna 409 `{ needsRestore: true }` sem consumir tentativas
- [x] `/connect/status` retorna `{ needsRestore: true }`

## Respostas padronizadas

### /connect/qrcode
```json
{ "connected": false, "qrBase64": "...", "nextRefreshSeconds": 10, "attemptsLeft": 2 }
```
- `qrBase64` é base64 puro; front use: `src={"data:image/png;base64," + qrBase64}`

### Códigos HTTP
- 401: auth
- 404: sem instância configurada
- 409: needsRestore
- 429: throttled/blocked (com retryAfterSeconds)
- 502: falha Z-API

## Scripts de teste

```bash
# Bash
TOKEN="seu_jwt" ./scripts/test-zapi-connect.sh
```

```powershell
# PowerShell
$env:TOKEN="seu_jwt"; .\scripts\test-zapi-connect.ps1
```
