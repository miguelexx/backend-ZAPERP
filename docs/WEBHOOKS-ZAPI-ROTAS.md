# Webhooks Z-API — Rotas e payloads

Referência das rotas do backend e dos callbacks Z-API para manter o sistema completo e funcional.

## URLs (configuradas automaticamente via API)

| Uso no painel Z-API | URL do backend | Método | Tipo de callback |
|---------------------|----------------|--------|-------------------|
| Ao receber / Ao enviar | `{APP_URL}/webhooks/zapi` | POST | ReceivedCallback, DeliveryCallback |
| Receber status da mensagem | `{APP_URL}/webhooks/zapi/status` | POST | MessageStatusCallback |
| Ao conectar / Ao desconectar | `{APP_URL}/webhooks/zapi/connection` | POST | connected / disconnected |
| Status do chat (digitando) | `{APP_URL}/webhooks/zapi/presence` | POST | PresenceChatCallback |

Obter todas as URLs: `GET /webhooks/zapi` retorna `urls` e `webhooks` para copiar no painel.

### Token do webhook (obrigatório)

Todas as URLs POST devem incluir o token. Aceito via:
- Header `X-Webhook-Token: <token>`
- Header `Authorization: Bearer <token>`
- Query `?token=<token>` (ex: `{APP_URL}/webhooks/zapi?token=SEU_ZAPI_WEBHOOK_TOKEN`)

### instanceId no payload

O backend resolve `instanceId` → `company_id` via `empresa_zapi.instance_id` (case-insensitive).  
Aceita: `body.instanceId`, `body.instance_id`, `body.instance?.id`, `body.instance` (string).

---

## 1. POST /webhooks/zapi (mensagens)

Recebe **ReceivedCallback** (mensagem recebida ou enviada por mim) e **DeliveryCallback** (confirmação de envio).

### ReceivedCallback (doc Z-API)

- `type`: "ReceivedCallback"
- `phone`: número do chat (destino se fromMe). Para **grupos**: JID ex. `12036301234567890@g.us` ou dígitos `12036301234567890`
- `fromMe`: boolean
- `messageId`, `momment`, `status`, `text.message`, `senderLid`, `connectedPhone`, `chatName`, `senderName`, `participantPhone` (grupos), `image.*`, `audio.*`, `video.*`, `document.*`, `location.*`, `contact.*`, `sticker.*`, etc.

O backend usa `payload.momment ?? payload.timestamp`, `payload.text?.message ?? payload.body`, e persiste + emite `nova_mensagem` e `atualizar_conversa`.

**Grupos:** O backend aceita `phone` com `@g.us`, `-group`, ou IDs numéricos (120... 15–22 dígitos). Aceita também `key.remoteJid`, `chatId`, `groupId`. Para funcionar, confirme no painel Z-API que a opção "Ao receber" está ativa e que a instância está em um número que participa dos grupos.

### DeliveryCallback (doc Z-API)

- `type`: "DeliveryCallback"
- `phone`, `zaapId`, `messageId`, `instanceId`

O backend atualiza `mensagens.status` e emite `status_mensagem` (ticks).

---

## 2. POST /webhooks/zapi/status (status da mensagem)

- `ids`: array de IDs **ou** `messageId` / `zaapId` / `id`
- `status` ou `ack`: SENT, RECEIVED, READ, READ_BY_ME, PLAYED (ou ACK 0–4)

Atualiza `mensagens.status` e emite `status_mensagem` para a empresa e a conversa.

---

## 3. POST /webhooks/zapi/connection

- Conectar: dispara configuração automática dos webhooks + sync de contatos (e notifySentByMe).
- Desconectar: apenas log.

Resposta sempre 200.

---

## 4. POST /webhooks/zapi/presence

- `type`: "PresenceChatCallback"
- `phone`, `status` (UNAVAILABLE | AVAILABLE | COMPOSING | RECORDING | PAUSED), `lastSeen`, `instanceId`

O backend localiza a conversa pelo `phone` e emite evento Socket.IO `presence` para `empresa_*` e `conversa_*` (para exibir “digitando…” no front).

Resposta sempre 200.

---

## Configuração automática (provider)

Em `services/providers/zapi.js`, `configureWebhooks(appUrl)` chama:

- `update-webhook-received` (body: `{ value, notifySentByMe: true }`)
- `update-webhook-delivery` → mesma URL que received
- `update-webhook-status` → URL /status
- `update-webhook-disconnected` e `update-webhook-connected` → URL /connection
- `update-webhook-chat-presence` → URL /presence
- `update-notify-sent-by-me` (fallback)

Requer `ZAPI_CLIENT_TOKEN` no `.env` e `APP_URL` definido.
