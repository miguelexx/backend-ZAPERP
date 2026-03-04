# Checklist: Configurar webhooks no painel Z-API

## URLs completas (substitua APP_URL e TOKEN)

**Obrigatório**: Todas as URLs de callback devem incluir `?token=ZAPI_WEBHOOK_TOKEN` (o mesmo do .env).

| Callback no painel Z-API | URL | Método |
|--------------------------|-----|--------|
| Ao receber mensagem | `{APP_URL}/webhooks/zapi?token={TOKEN}` | POST |
| Ao enviar mensagem | `{APP_URL}/webhooks/zapi?token={TOKEN}` | POST |
| Receber status da mensagem (ticks ✓✓) | `{APP_URL}/webhooks/zapi/status?token={TOKEN}` | POST |
| Ao conectar | `{APP_URL}/webhooks/zapi/connection?token={TOKEN}` | POST |
| Ao desconectar | `{APP_URL}/webhooks/zapi/connection?token={TOKEN}` ou `/disconnected?token={TOKEN}` | POST |
| Status do chat (digitando) | `{APP_URL}/webhooks/zapi/presence?token={TOKEN}` | POST |

**Alternativa**: Todas as URLs acima podem ser substituídas pela principal: `{APP_URL}/webhooks/zapi?token={TOKEN}` — o backend roteia por `payload.type` internamente.

## Exemplos por APP_URL

### Produção: `https://api.zaperp.com`
- Ao receber/ao enviar: `https://api.zaperp.com/webhooks/zapi`
- Status da mensagem: `https://api.zaperp.com/webhooks/zapi/status`
- Conexão: `https://api.zaperp.com/webhooks/zapi/connection`
- Presença: `https://api.zaperp.com/webhooks/zapi/presence`

### Local (ngrok): `https://abc123.ngrok.io`
- Ao receber/ao enviar: `https://abc123.ngrok.io/webhooks/zapi`
- Status: `https://abc123.ngrok.io/webhooks/zapi/status`
- Conexão: `https://abc123.ngrok.io/webhooks/zapi/connection`
- Presença: `https://abc123.ngrok.io/webhooks/zapi/presence`

## Token (obrigatório)

- **ZAPI_WEBHOOK_TOKEN**: Defina no .env. Todos os POSTs de webhook validam o token via `X-Webhook-Token` ou `?token=`.
- Sem token válido: 401 (não expõe valores do token).
- O GET `/webhooks/zapi` e `/webhooks/zapi/health` são públicos (sem auth).

## Health check

Antes de configurar, verifique se o backend responde:
```bash
curl -s https://SEU_APP_URL/webhooks/zapi/health
# Esperado: {"ok":true}
```

## Multi-tenant: instanceId obrigatório

O payload da Z-API **deve** incluir o campo `instanceId` (ou `instance_id`/`instance`).
O backend mapeia `instanceId` → `empresa_zapi.instance_id` → `company_id`.

Se `instanceId` não estiver no payload, o backend retorna 200 mas não processa (log: "instance not mapped" ou "webhook sem instanceId").

Verifique no painel Z-API se a versão da instância envia `instanceId` nos callbacks.
