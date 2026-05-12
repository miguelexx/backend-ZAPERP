# UltraMSG — integração oficial (ZapERP)

Única integração WhatsApp ativa no código: **`services/providers/ultramsg.js`**, exposta por **`services/providers/index.js`** (`getProvider()`).

---

## 1. Modelo mental

| Camada | Descrição |
|--------|-----------|
| **Entrada** | HTTP `POST` do cloud UltraMSG → `/webhooks/ultramsg` (alias `/webhooks/whatsapp`) |
| **Autenticação do webhook** | `WHATSAPP_WEBHOOK_TOKEN` (`middleware/requireWebhookToken`) |
| **Resolução de tenant** | `instanceId` / `instance_id` no corpo → `company_id` (`middleware/resolveWebhookCompany` + `whatsappConfigService`) |
| **Normalização** | `webhookUltramsgController.normalizeUltramsgToZapi` |
| **Processamento** | Delegação a `webhookZapiController` (**nome legado**; não é endpoint Z-API público) |
| **Saída** | REST UltraMSG `https://api.ultramsg.com/{instance…}/` com `instance_token` |

---

## 2. Credenciais por empresa

- Tabela **`empresa_zapi`** (`migrations/20260302000000_empresa_zapi.sql`): `company_id` **único**, `instance_id`, `instance_token`, `client_token`, `ativo`.
- O provider constrói URL base com prefixo **`instance`** obrigatório (`buildBaseUrl` em `ultramsg.js`).
- Leitura consolidada via **`getEmpresaWhatsappConfig`** / `whatsappConfigService.js`.

---

## 3. Webhook — URL e token

- **Path público:** `/webhooks/ultramsg` (recomendado) ou `/webhooks/whatsapp`.
- **Token na query:** `?token=<WHATSAPP_WEBHOOK_TOKEN>` (também aceites headers conforme `requireWebhookToken`).
- **GET `/webhooks/ultramsg`:** resposta JSON com `webhook_url` sugerida (`testarUltramsg`).
- **Health:** `GET /webhooks/ultramsg/health` → `{ ok, provider: 'ultramsg' }`.

**Comentário em `app.js`:** Meta Cloud API removida do fluxo principal; mantém-se `rawBody` no parser para compatibilidade com verificação HMAC onde aplicável.

---

## 4. Eventos tratados (`handleWebhookUltramsg`)

| Evento (event_type) | Ação |
|---------------------|------|
| `message_ack`, `webhook_message_ack` | Normaliza → **`statusZapi`** (atualiza status de mensagem) |
| `message_received`, `message_create`, `webhook_message_received`, `webhook_message_create`, `webhook_message_download_media`, `webhook_message_reaction`, `message_reaction`, ou payload com `data.from` / `data.id` | Normaliza → **`receberZapi`** |

Eventos não reconhecidos: resposta **`200 { ok: true }`** sem processar.

---

## 5. Estrutura típica do payload (entrada)

Documentado em comentário no topo de `webhookUltramsgController.js`:

- Campos de envelope: `event_type`, `instanceId`, `data`, …
- **`data`:** `from`, `to`, `author`, `pushname`, `ack`, `type`, `body`, `media`, `fromMe`, `quotedMsg`, `time`, …

**Parsing defensivo:** `resolveWebhookBody` tenta JSON aninhado em `payload` / `body` string.

---

## 6. Normalização — pontos críticos

### 6.1 `fromMe`

- Boolean explícito; influencia escolha do JID de contacto (`from` vs `to`) em chat individual.

### 6.2 Grupos (`@g.us`)

- `phone` = JID completo do grupo (não normalizar agressivamente — comentário no código sobre preservação do hífen).
- `participantPhone` derivado de `author` / `sender` / `from`.

### 6.3 `messageId`

- Preferência por **`data.id`** (formato UltraMSG incl. sufixos) alinhado ao que chega no `message_ack`.

### 6.4 Mídia

- `data.media` pode ser string URL ou objeto com `url` / `link` / `file`.
- Tipos: `image`, `audio`, `ptt`, `document`, `video`, `sticker` — mapeamento para URLs dedicadas na normalização.

### 6.5 Localização

- Coordenadas em `data` ou `data.location`.
- **Não** usar `body` como endereço se for Base64 de miniatura de mapa (detecção `isBodyBase64Image`).

### 6.6 Acks

- `mapUltramsgAckToStatus` traduz valores UltraMSG (`pending`, `server`, `device`, `read`, `played`, numéricos) para strings internas.

---

## 7. Envio (REST)

Implementado em `ultramsg.js` (métodos chamados pelo `chatController` e outros serviços):

- Texto, imagem, áudio, voz, vídeo, documento, sticker, contacto (vCard), localização, reação, etc.
- **Limites:** `BODY_MAX_LEN = 4096`, `CAPTION_MAX_LEN = 1024`, `FILENAME_MAX_LEN = 255`.
- **Conteúdo:** predominantemente **`application/x-www-form-urlencoded`** com `token` injetado (`appendToken`).
- **Timeout:** `ULTRAMSG_TIMEOUT_MS` (default 30s).
- **Delay entre envios:** `ULTRAMSG_SEND_DELAY_MS` + mapa `lastSendPerCompany`.
- **Áudio:** `normalizeAudioUrl` ajusta data URIs `webm`/`opus` → `ogg` quando necessário para compatibilidade.

---

## 8. Configuração remota da instância

- Função **`configureWebhooks`** no provider: envia `webhook_url`, flags `webhook_message_*`, `sendDelay`, `sendDelayMax`, `webhook_retries`, etc., conforme variáveis de ambiente documentadas no próprio `ultramsg.js`.
- Endpoint administrativo: **`POST /integrations/whatsapp/configure-webhooks`** (autenticado).

---

## 9. API de mensagens enviadas (painel)

- Rotas em **`whatsappIntegrationRoutes.js`:** `GET /integrations/whatsapp/messages`, `GET .../messages/statistics` (também sob `/api/...`).
- Documentação de query params: ver `backend/docs/API-MESSAGES-ULTRAMSG.md` na raiz de docs.

---

## 10. Idempotência e duplicatas

- Índices únicos em `mensagens` para `(conversa_id, whatsapp_id)` ou `(company_id, whatsapp_id)` conforme migrações — ver [DATABASE.md](./DATABASE.md).
- Webhook deve ser tolerado a **reentregas**; o núcleo de insert deve usar conflito/ignore ou upsert conforme implementação atual (`receberZapi`).

---

## 11. Limitações e cuidados

| Tópico | Cuidado |
|--------|---------|
| LID / identificadores não telefónicos | Fluxos de chatbot podem ignorar mensagens sem telefone real — ver serviços de triagem |
| Payload variável | UltraMSG evolui campos; manter `normalizeUltramsgToZapi` como único adaptador |
| Logs | `WHATSAPP_DEBUG` controla verbosidade; nunca logar tokens completos (`maskToken`) |
| Erros no webhook | Respostas `200` em vários caminhos para evitar storm de retries do provider |

---

## 12. O que **não** faz parte desta integração

- **Z-API** como URL pública montada em `app.js` (não presente na árvore analisada).
- **Meta Cloud** como webhook principal (comentário em `app.js` indica remoção do fluxo principal).

---

## 13. Referência histórica

Detalhes longos antigos foram arquivados em **`../_ANTIGOS/ULTRAMSG-CONFIGURACAO-ENVIO.md`**. Em caso de divergência com o código, **prevalece o código**.
