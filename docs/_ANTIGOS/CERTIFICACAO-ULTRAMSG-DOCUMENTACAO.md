# Certificação — Documentação UltraMsg vs Sistema

**Data:** 2025-03-12  
**Objetivo:** Garantir que toda a documentação em `ULTRAMSG-CONFIGURACAO-ENVIO.md` está implementada e configurada no sistema.

---

## 1. Configuração da instância (configureWebhooks)

| Campo doc | Implementado em | Status |
|-----------|-----------------|--------|
| `sendDelay` | `ultramsg.js` configureWebhooks, env `ULTRAMSG_SEND_DELAY` | ✅ |
| `sendDelayMax` | `ultramsg.js` configureWebhooks, env `ULTRAMSG_SEND_DELAY_MAX`, garantido ≥ sendDelay | ✅ |
| `webhook_url` | Montado como `{APP_URL}/webhooks/ultramsg?token={WHATSAPP_WEBHOOK_TOKEN}` | ✅ |
| `webhook_retries` | `ultramsg.js` configureWebhooks, env `ULTRAMSG_WEBHOOK_RETRIES` | ✅ |
| `webhook_message_received` | Enviado `true` em configureWebhooks | ✅ |
| `webhook_message_create` | Enviado `true` em configureWebhooks | ✅ |
| `webhook_message_ack` | Enviado `true` em configureWebhooks | ✅ |
| `webhook_message_download_media` | Enviado via `ULTRAMSG_WEBHOOK_DOWNLOAD_MEDIA` | ✅ |
| `webhook_message_reaction` | Enviado `true` em configureWebhooks | ✅ |

---

## 2. Rotas de webhook

| Rota doc | app.js | Middleware | Status |
|----------|--------|------------|--------|
| POST /webhooks/ultramsg | `app.use('/webhooks/ultramsg', ...)` | webhookLogger, requireWebhookToken, resolveWebhookZapi | ✅ |
| POST /webhooks/whatsapp | `app.use('/webhooks/whatsapp', ...)` | Alias para ultramsg | ✅ |
| GET /webhooks/ultramsg/health | webhookUltramsgRoutes | webhookUltramsgController.healthUltramsg | ✅ |

**Autenticação:** `requireWebhookToken` aceita `?token=`, `X-Webhook-Token`, `Authorization: Bearer` — conforme doc (token na query).

---

## 3. Eventos webhook tratados

| Evento UltraMsg | webhookUltramsgController | Status |
|-----------------|---------------------------|--------|
| message_received | isMessageEvent → receberZapi | ✅ |
| message_create | isMessageEvent → receberZapi | ✅ |
| webhook_message_received | isMessageEvent → receberZapi | ✅ |
| webhook_message_create | isMessageEvent → receberZapi | ✅ |
| webhook_message_download_media | isMessageEvent → receberZapi | ✅ |
| webhook_message_reaction | isMessageEvent → receberZapi | ✅ |
| message_reaction | isMessageEvent → receberZapi | ✅ |
| message_ack / webhook_message_ack | statusZapi | ✅ |

---

## 4. Roteamento de envio (chatController)

| Fluxo doc | Rota | chatRoutes | chatController | Status |
|-----------|------|------------|----------------|--------|
| Envio texto | POST /chats/:id/mensagens | `router.post('/:id/mensagens', ...)` | enviarMensagemChat | ✅ |
| Envio mídia/arquivo | POST /chats/:id/arquivo | `router.post('/:id/arquivo', ...)` | enviarArquivo | ✅ |
| Envio contato | POST /chats/:id/contatos | `router.post('/:id/contatos', ...)` | enviarContatoWhatsapp | ✅ |
| Envio localização | POST /chats/:id/localizacao | `router.post('/:id/localizacao', ...)` | enviarLocalizacao | ✅ |
| Reação | POST /chats/:id/mensagens/:id/reacao | `router.post('/:id/mensagens/:mensagem_id/reacao', ...)` | enviarReacaoMensagem | ✅ |
| Remover reação | DELETE /chats/:id/mensagens/:id/reacao | `router.delete(...)` | removerReacaoMensagem | ✅ |
| Excluir mensagem | DELETE /chats/:id/mensagens/:id | `router.delete(...)` | excluirMensagem | ✅ |

Rotas expostas em `/chats` e `/api/chats` (app.js).

---

## 5. API UltraMsg (provider)

| Endpoint doc | Função provider | Status |
|-------------|-----------------|--------|
| GET /messages (page, limit, status, sort) | `getMessages(opts)` | ✅ |
| GET /messages/statistics | `getMessagesStatistics(opts)` | ✅ |
| POST /messages/chat | `sendText()` | ✅ |
| POST /messages/image | `sendImage()` | ✅ |
| POST /messages/document | `sendFile()` | ✅ |
| POST /messages/audio | `sendAudio()` | ✅ |
| POST /messages/voice | `sendVoice()` | ✅ |
| POST /messages/video | `sendVideo()` | ✅ |
| POST /messages/sticker | `sendSticker()` | ✅ |
| POST /messages/vcard | `sendContact()` | ✅ |
| POST /messages/location | `sendLocation()` | ✅ |
| POST /messages/reaction | `sendReaction()` | ✅ |

---

## 6. Variáveis de ambiente (.env.example)

| Variável doc | .env.example | Status |
|--------------|--------------|--------|
| APP_URL | Presente | ✅ |
| WHATSAPP_WEBHOOK_TOKEN | Presente | ✅ |
| ULTRAMSG_BASE_URL | Presente | ✅ |
| ULTRAMSG_INSTANCE_ID | Presente | ✅ |
| ULTRAMSG_TOKEN | Presente | ✅ |
| ULTRAMSG_SEND_DELAY | Comentado (1) | ✅ |
| ULTRAMSG_SEND_DELAY_MAX | Comentado (15) | ✅ |
| ULTRAMSG_WEBHOOK_RETRIES | Comentado (3) | ✅ |
| ULTRAMSG_WEBHOOK_DOWNLOAD_MEDIA | Comentado (true) | ✅ |

---

## 7. Formato de envio (provider)

| Regra doc | Implementação | Status |
|-----------|---------------|--------|
| `to`: +55... ou xxx@g.us | `toUltramsgPhone()`, `phoneCandidatesForSend()` | ✅ |
| body máx 4096 caracteres | `BODY_MAX_LEN = 4096` em sendText | ✅ |
| caption máx 1024 caracteres | `CAPTION_MAX_LEN = 1024` | ✅ |
| filename máx 255 caracteres | `FILENAME_MAX_LEN = 255` | ✅ |
| token injetado em todas requisições | `appendToken()` em post/get | ✅ |

---

## 8. Chamada de configureWebhooks

| Onde | Arquivo | Status |
|------|---------|--------|
| Ao conectar instância | webhookZapiController (fluxo connect) | ✅ |
| Usa provider.configureWebhooks | Chamado com appUrl e companyId | ✅ |

---

## 9. Índice de documentação

| Doc | README-DOCS.md | MIGRACAO-ULTRAMSG | Status |
|-----|----------------|-------------------|--------|
| ULTRAMSG-CONFIGURACAO-ENVIO.md | Listado | Link de referência | ✅ |

---

## Resumo

| Categoria | Itens | Ok | Falhas |
|-----------|-------|-----|--------|
| Config webhooks | 9 | 9 | 0 |
| Rotas webhook | 3 | 3 | 0 |
| Eventos webhook | 8 | 8 | 0 |
| Rotas envio | 7 | 7 | 0 |
| API provider | 12 | 12 | 0 |
| Variáveis .env | 9 | 9 | 0 |
| Formato envio | 5 | 5 | 0 |
| Chamada configureWebhooks | 1 | 1 | 0 |
| Índice docs | 2 | 2 | 0 |

**Certificação:** ✅ Todas as documentações estão configuradas no sistema.

---

## Correção aplicada durante certificação

- **webhook_message_reaction** e **message_reaction** foram adicionados à lista `isMessageEvent` em `webhookUltramsgController.js`, pois a doc previa `webhook_message_reaction: true` mas o handler não os processava.
