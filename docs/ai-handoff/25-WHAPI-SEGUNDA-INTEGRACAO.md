# 25 — Whapi Cloud: segunda integração WhatsApp (aditiva, UltraMSG intocável)

> Criado: **2026-09-03**. **Fase A EXECUTADA em 2026-09-04**. **Fase B EXECUTADA em 2026-09-04** (mídia + contrato MCP fechado). **Fase C parcial EXECUTADA em 2026-09-04** (`configureWebhooks` real + roteamento de status/QR/restart por instância). **Fases D+E parciais EXECUTADAS em 2026-09-04** (delete/edit/read/sync reais + roteamento `getProvider({ provider })` em chatbot/encerrar/alertas/disparo; pasta `ultramsg/` intocada). **Auditoria de instâncias 2026-09-05:** `resolveConversationWhatsappInstance` + gates `getEmpresaWhatsappConfig` corrigidos para empresa só-Whapi. QR/pairing e UI de cadastro ainda plano.
> Fonte: código atual (providers/index, ultramsg shim, webhookUltramsgController, resolveWebhookCompany,
> whatsappInstanceService, outboundController) + docs 06/14/18/21/24.
> Estados: **CONFIRMADO** = li no código / MCP / OpenAPI Whapi; **INFERÊNCIA**; **PENDENTE** = homologação live.

## Objetivo (ler duas vezes)

Adicionar **Whapi Cloud** como **segundo provider WhatsApp opcional por instância** (`whatsapp_instances.provider = 'whapi'`),
sem migrar, sem substituir, sem unificar adapter. UltraMSG continua **idêntico** para toda empresa/número que já usa.
Se uma empresa não tem Whapi configurada, o comportamento é **byte-a-byte** o de hoje.

Regra de ouro: se qualquer desenho exigir editar o miolo da UltraMSG "para ficar genérico", o desenho está **errado**. Refazer aditivo.

---

## 0. Declaração pré-ação

### 0.1 Arquivos NOVOS (aditivos, não tocam UltraMSG)

```
services/providers/whapi.js                         ← shim: module.exports = require('./whapi/index.js')
services/providers/whapi/
  index.js            ← API pública Whapi (mesmos NOMES de método do contrato interno)
  constants.js        ← base url, timeouts, MIME
  http.js             ← Bearer + JSON, post/get, timeout, retry só-conexão, maskToken
  config.js           ← resolveConfig (companyId + whatsappInstanceId → channel id + token)
  phones.js           ← regras de JID Whapi (internacional s/ +, grupos @g.us) — NÃO importa phones da ultramsg
  result.js           ← normalizeWhapiSendResult ({ ok, messageId, error })
  send.js             ← sendText + mídia/reação/contato/localização (Fase B)
  messages.js         ← delete/edit/mark-read/getMessages (DELETE/POST edit/PUT read)
  chatsAdmin.js       ← archive/read/deleteChat + getChats/getGroups/getGroup
  contacts.js         ← getContacts/getContactMetadata/getProfilePicture
  chatMessages.js     ← getChatMessages (GET /messages/list/{ChatID})
  parse.js            ← extractArray / sucesso HTTP
  upload.js           ← POST /media (Fase B)
  instanceAdmin.js    ← getConnectionStatus/health/QR-pairing/configureWebhooks/perfil
controllers/webhookWhapiController.js               ← normalizeWhapiToInternal + delega a receberZapi/statusZapi
middleware/resolveWhapiWebhookCompany.js            ← channel id → company_id (provider='whapi')
routes/webhookWhapiRoutes.js                        ← POST /webhooks/whapi
supabase/migrations/2026XXXXHHMMSS_whatsapp_instances_provider_whapi.sql  ← ALTER CHECK (NÃO aplicar)
tests/whapiProvider*.test.js, tests/whapiWebhook*.test.js, tests/providerRouting.test.js
```

### 0.2 Arquivos EXISTENTES que o desenho pode editar (só aditivo)

| Arquivo | Edição permitida | Invariante preservada |
|---|---|---|
| `services/providers/index.js` | `getProvider(opts)` roteia por `opts.provider`; **default e no-arg → ultramsg** | `getProvider()` sem arg = ultramsg; `jest.mock('../services/providers/ultramsg')` intacto |
| `services/whatsappInstanceService.js` | `normalizeProvider` ganha allowlist `['ultramsg','whapi']` (desconhecido→ultramsg) | Já é parametrizado por provider em todas as queries; DEFAULT_PROVIDER='ultramsg' |
| `app.js` | montar `app.use('/webhooks/whapi', webhookLimiter, webhookWhapiRoutes)` NOVO | **Não** tocar `/webhooks/ultramsg` nem o alias `/webhooks/whatsapp` |
| chat controllers (`outbound/text/media/...`) | trocar `getProvider()` → `getProvider({ provider })`, passando o provider da instância **já resolvida** | Fallback: sem provider conhecido → ultramsg. Fase A só faz isso para **texto** |
| frontend `ConnectWhatsApp.jsx` + API instâncias | escolher Provider (UltraMSG default \| Whapi) + campos Channel ID/Token | Não tocar lista/thread/composer/scroll (Fase C) |

### 0.3 Riscos / migration / socket

- **Precisa migration?** Sim — 1 aditiva (CHECK aceitar `'whapi'` + comentários de coluna). **Não cria colunas novas.** Reusa `provider` / `instance_id` / `instance_token`. **Escrita, NÃO aplicada.**
- **Precisa evento Socket novo?** **Não.** `nova_mensagem` / `status_mensagem` / `atualizar_conversa` bastam — o normalizador Whapi entrega o mesmo formato interno; o pipeline emite os mesmos eventos.
- **Risco de regressão UltraMSG:** meta **zero** com `provider=ultramsg`. Ver §7.
- **Risco de mensagem duplicada:** nunca cadastrar o **mesmo número** nas duas APIs simultaneamente (ambas entregariam webhook). Documentado; sem trava automática de banco (números diferentes por design).

### 0.4 Mesma tabela `whatsapp_instances` (sem colunas paralelas)

Não criar `whapi_token` / `whapi_id`. Uma linha nova, mesmos campos:

| Coluna | UltraMSG (já existe) | Whapi (mesma coluna) |
|---|---|---|
| `provider` | `ultramsg` | `whapi` |
| `instance_id` | `instance51534` | channel id `NEBULA-AER3B` |
| `instance_token` | token UltraMSG | Bearer do canal |
| `client_token` | usado | `NULL` |
| `telefone_conectado` / `status` | preenchidos no QR/health UltraMSG | preenchidos no `GET /health` após criar |
| `is_default` | default da empresa | **false** se a empresa já tem default UltraMSG (índice único por `company_id`) |

`POST /integrations/whatsapp/instances` aceita `channel_id` como alias de `instance_id`. `provider` não pode ser alterado depois (cria outra linha).

---

## 1. Arquitetura (UltraMSG intocada vs Whapi aditiva)

```
                         ┌──────────────────────────── ENVIO (outbound) ────────────────────────────┐
 chat controllers        │  resolveConversationWhatsappInstance(company, conversa) → whatsappInstanceId │
 (outbound/text/media)   │  const provider = getProvider({ provider: instancia.provider })              │
                         │        provider='ultramsg' (default/no-arg) ─────► services/providers/ultramsg (INTOCADO)
                         │        provider='whapi' ──────────────────────────► services/providers/whapi (NOVO)
                         └──────────────────────────────────────────────────────────────────────────────┘

                         ┌──────────────────────────── RECEBER (inbound/ACK) ──────────────────────────┐
 UltraMSG POST  ─► /webhooks/ultramsg ─► requireWebhookToken ─► resolveWebhookCompany('ultramsg')
                                        ─► webhookUltramsgController.normalizeUltramsgToZapi
                                        ─────────────────────────────────────────────────┐
                                                                                          ▼
 Whapi POST     ─► /webhooks/whapi     ─► requireWhapiWebhookToken ─► resolveWhapiWebhookCompany('whapi')   NÚCLEO ATIVO
                                        ─► webhookWhapiController.normalizeWhapiToInternal ─► receberZapi / statusZapi
                                                                                          ▲   (webhookZapiController —
                                        ─────────────────────────────────────────────────┘    nome legado, intocado)
```

Ponto central: **UltraMSG e Whapi convergem para o MESMO objeto interno "zapi-like"** e chamam **as mesmas** `receberZapi`/`statusZapi`.
O núcleo (chat, chatbot, mídia, disparo, socket, frontend) **nunca** sabe qual provider falou. Quem traduz é o adapter (envio) e o normalizador de webhook (recebimento).

**Fachada de roteamento** (`services/providers/index.js`) — desenho:

```js
const ultramsg = require('./ultramsg')
const whapi = require('./whapi')            // NOVO
function getProvider(opts = {}) {
  const p = String(opts.provider || '').trim().toLowerCase()
  if (p === 'whapi') return whapi
  return ultramsg                            // default + no-arg + 'ultramsg' + desconhecido
}
module.exports = { getProvider, ultramsg, whapi }
```

Invariante: **todo caller atual usa `getProvider()` sem arg → recebe ultramsg**. Nada quebra antes de os callers passarem `{ provider }`.

---

## 2. Contrato interno do provider (métodos, retornos, erros)

Fonte da verdade: `services/providers/ultramsg/index.js` (API pública). O adapter Whapi expõe **os mesmos nomes**.
Nas fases iniciais, o que não for implementado é **stub 501 explícito** (`{ ok:false, error:'not_implemented', status:501 }` ou `false`), **nunca** fingir sucesso.

### 2.1 Envio (retornos preservados por caller)

| Método | Retorno esperado (contrato UltraMSG) | Whapi Fase |
|---|---|---|
| `sendText(phone, body, opts)` | `{ ok, messageId, error, ... }` (objeto, **não** boolean) | **A (real)** |
| `sendLink` | idem (UltraMSG só chama sendText) | A |
| `sendImage/sendFile/sendVideo/sendSticker` | `false`/`true`, **ou** objeto se `opts.returnDetails===true` | **B (real)** |
| `sendAudio/sendVoice` | idem; 200 sem aceite = falha | **B (real)** |
| `sendReaction/removeReaction` | boolean (`PUT /messages/{id}/reaction`) | **B (real)** |
| `sendContact/sendLocation` | boolean/objeto | **B (real)** |
| `sendCall` | `{ ok, messageId }` — POST `/calls/outgoing` `{ to, duration }` (chamada de atenção; 503 liga `outgoing_calls_enabled` e retenta) | **real (2026-09-07)** |

`opts` sempre carrega `{ companyId, whatsappInstanceId, referenceId?, returnDetails? }`.
**HTTP 401/403 / `sent=false` NÃO é sucesso** → `normalizeWhapiSendResult` exige id de mensagem ou flag de sucesso.

### 2.2 Chat admin / consultas / instância

| Grupo | Métodos | Whapi |
|---|---|---|
| Chat admin | `deleteMessage` DELETE `/messages/{id}`; `editMessage` POST `/messages/text` `{edit}`; `readChat` PATCH `/chats/{id}` `{mark_unread:false}`; `archiveChat`/`unarchiveChat` POST `{archive}`; `deleteChat` DELETE `/chats/{id}` | **real** |
| Consultas | `getContacts` GET `/contacts`; `getChats` GET `/chats`; `getGroups`/`getGroup`; `getChatMessages` GET `/messages/list/{ChatID}`; `getProfilePicture` GET `/contacts/{id}/profile`; `getContactMetadata`; `checkPhones` POST `/contacts` `{contacts}` | **real** |
| Opcionais (2026-09-07) | `forwardMessage` POST `/messages/{MessageID}` `{to,force?}`; `checkPhones` POST `/contacts` `{contacts,force_check?}` → `[{input,exists,waId}]`; `getLoginQr` GET `/users/login/image` (PNG→dataURI) | **real (código; live PENDENTE)** |
| Instância | `getConnectionStatus`, `configureWebhooks`, `updateProfile*` (`PATCH /users/profile`); `getLoginQr` (QR real) | A/C + perfil + QR |
| UltraMSG-only | `clearChatMessages`, `resendByStatus/Id`, `getMessagesStatistics`, `clearMessages` | stub 501 |

### 2.3 Regras de erro / rede (iguais em espírito ao UltraMSG)

- Retry de POST de mensagem **só** em erro de conexão (nunca timeout/resposta ambígua) — reusar `helpers/retryWithBackoff` (`fetchWithRetry`, `isConnectionLevelError`).
- Reusar `whatsappSendGuardService` (`beforeWhatsAppSend`/`afterWhatsAppSend`) por `whatsappInstanceId` — espaça por número.
- `uploadMedia` **pode** retentar (não dispara mensagem).
- **Segredos:** token Whapi só em `instance_token`; **nunca** logar token/Bearer/URL-com-token/mídia base64. `maskTokenInLogs` próprio.

### 2.4 Telefone / JID Whapi (NÃO reusar as 4 APIs de JID da UltraMSG)

- **Proibido** chamar `toUltramsgPhone` / `phoneToChatId` / `profilePictureChatIdCandidates` / `chatMessageCandidatesForLookup`.
- Whapi: `to` = número internacional **sem `+`** (ex. `5534999999999`), grupos `...@g.us`, contatos podem chegar `...@s.whatsapp.net`.
- Normalização BR: usar `helpers/phoneHelper` (`normalizePhoneBR`, `preferredBrSendDigits`, `possiblePhonesForWhatsappIdentity`) — mesma base que a identidade WhatsApp já usa, sem a mangueira de JID UltraMSG.
- **CONFIRMADO (OpenAPI `sendMessageText` + MCP schema):** `to` aceita dígitos puros **ou** Chat ID com sufixo (`5534…@s.whatsapp.net` / `@g.us` / `@lid`). O adapter envia dígitos no privado (sem sufixo).

---

## 3. Mapa de webhooks Whapi → formato interno

**CONFIRMADO 2026-09-04** via MCP (`checkHealth` `wakeup:false`, `getChannelSettings` GET, schemas `sendMessage*`) + OpenAPI `SentMessage` + docs oficiais de incoming webhooks. Não enviamos mensagem nem alteramos settings.

Whapi envia **arrays** por evento: `messages` (inbound e `from_me`) e `statuses` (ACK). Envelope:

```json
{
  "messages": [ { "id", "from_me", "type", "chat_id": "55…@s.whatsapp.net", "timestamp", "source", "text": { "body" }, "from": "55…", "from_name" } ],
  "event": { "type": "messages", "event": "post" },
  "channel_id": "NEBULA-AER3B"
}
```

```json
{
  "statuses": [ { "id", "code": 4, "status": "read", "recipient_id": "55…@s.whatsapp.net", "timestamp" } ],
  "event": { "type": "statuses", "event": "post" },
  "channel_id": "NEBULA-AER3B"
}
```

| Interno (zapi-like) | UltraMSG origem | Whapi origem **CONFIRMADO** |
|---|---|---|
| `instanceId` / `instance_id` | `body.instanceId` (numérico) | `channel_id` (ex. `NEBULA-AER3B`) |
| `messageId` / `id` / `zaapId` | `data.id` | `message.id` (wamid estilo `p.w30M7f…-gBgTwl0rVw`) |
| `fromMe` | `data.fromMe` | `message.from_me` |
| `phone` / `remoteJid` | JID de `from`/`to` | `message.chat_id` (privado `…@s.whatsapp.net` / grupo `…@g.us`) |
| `participantPhone` | `data.author` | `message.from` em grupo (dígitos ou JID) |
| `type` | `data.type` (`ptt`→`audio`) | `text`→`chat`; `voice`/`ptt`→`audio`; `link_preview`→`chat`; `live_location`→`location`; **reação = `type: action` + `action.type: reaction`** (não `type: reaction`) |
| `body`/`message`/`text.message` | `data.body` | `message.text.body` ou caption / `link_preview.body` |
| `imageUrl/audioUrl/videoUrl/documentUrl/stickerUrl` | `data.media` | `message.<type>.link` — **só existe com Auto Download** (canal inspecionado já tem `auto_download` de image/audio/voice/video/document/sticker) |
| `senderName` (só `!fromMe`) | `data.pushname` | `message.from_name` |
| `quotedMsg` / `referenceMessageId` | `data.quotedMsg` | `message.context.quoted_id` / `quoted_content` |
| reação | `event=reaction`+quotedMsg | `action: { type: "reaction", target, emoji }` |
| `timestamp` | `data.time*1000` | `message.timestamp*1000` (unix s) |
| ACK `status` | `data.ack` | `statuses[].status` (`failed\|pending\|sent\|delivered\|read\|played\|deleted`) + `statuses[].code` (ex. `4` = read) |

**GET /health CONFIRMADO (MCP):** `{ status: { code: 4, text: "AUTH" }, user: { id: "55…" }, channel_id, uptime, start_at, device_id }`. `AUTH` = sessão conectada.

**POST /messages/* CONFIRMADO (OpenAPI `SentMessage`):** `{ sent: true, message?: { id, … } }`. `sent` obrigatório; `message.id` é o id síncrono quando presente.

**Higiene operacional (MCP GET 2026-09-04, sem PATCH):** canal `NEBULA-AER3B` em `AUTH` (`user.id` = 553499911246). O webhook do canal **ainda** aponta para `https://zapapi.wmsistemas.inf.br/webhooks/ultramsg?token=…` (token na query — vuln de log já conhecida). Eventos atuais incluem messages/statuses **e** chats/contacts/groups/calls/channel/users. **Não alteramos settings nesta sessão.** Homologação de receber **não funciona** enquanto o canal postar no parser UltraMSG.

Para receber: apontar para `POST {APP_URL}/webhooks/whapi` com header `X-Webhook-Token` = `WHATSAPP_WEBHOOK_TOKEN`, **sem** `?token=`. O adapter faz isso via `POST /integrations/whatsapp/instances/:id/configure-webhooks` (`PATCH /settings` só o campo `webhooks`; campos omitidos ficam iguais). Isso **substitui** o array `webhooks` do canal (não preserva eventos extras de chats/grupos — o CRM só processa `messages[]`/`statuses[]`). **Nunca no boot. Nunca em instância UltraMSG.** Rotacionar o token do canal **depois** da homologação.

```
POST /webhooks/whapi { messages:[...], statuses:[...], channel_id, event? }
  → resolveWhapiWebhookCompany: channel_id → company_id (provider='whapi')
  → para cada m em messages:   normalizeWhapiToInternal(m)  → req.body = {..., type:'ReceivedCallback'}   → receberZapi
  → para cada s em statuses:   normalizeWhapiStatus(s)       → req.body = {..., type:'MessageStatusCallback'} → statusZapi
```

Invariantes preservados (todos já garantidos pelo núcleo — o normalizador **não pode violá-los**):

1. **Chatbot NÃO dispara** em reação / Status/broadcast / grupo / `fromMe` / ACK. Origem = JID do chat, não `participant` (guarda `chatbotInboundGuard.js`).
2. **`fromMe`** (eco do que o CRM/celular enviou): nome/foto do payload são **nossos**, unread inicial 0, não emite `atualizar_conversa` na reconciliação.
3. **ACK sem regressão** (`pending→sent→delivered→read`), grupo capa `read/played` em `delivered` (`messageStatusHelper`).
4. **Idempotência** por `(company_id, whatsapp_instance_id, whatsapp_id)` — o `whatsapp_id` interno = id da mensagem Whapi.
5. **Mídia inbound** só por `inboundMediaPersistenceService` (HTTPS, SSRF, R2/local) — o normalizador entrega `imageUrl`/`audioUrl`/… a partir de `*.link`.
6. **HTTP:** inbound com erro interno persistente → 500 (retry provider); instância não mapeada / duplicada / ACK → 200 (igual ao UltraMSG).

**Auth webhook:** middleware **dedicado** `requireWhapiWebhookToken` (timing-safe, `WHATSAPP_WEBHOOK_TOKEN`) — aceita **só** header `X-Webhook-Token` ou `Authorization: Bearer`; **nunca `?token=` na query** (vuln de log conhecida) e **sem** o fallback por `instanceId`→`empresa_zapi` do `requireWebhookToken` (UltraMSG). Não reusa o middleware compartilhado justamente para não herdar `?token=`/fallback cross-provider. Fail-closed: env ausente → 500; token ausente/inválido → 401. Se a Whapi mandar header próprio de assinatura, validar adicionalmente. Tenant **sempre** pela instância resolvida, nunca do payload.

---

## 4. Estratégia de IDs / reconciliação / lacuna do `referenceId`

Problema: UltraMSG casa o eco `fromMe` do outbound via `referenceId` (`crm-<mensagemId>` / `disp-<filaId>`) gravado no body do send.
**Whapi não documenta campo `referenceId` no `/messages/text`.** Não inventar um.

Solução do dia-1 (mais simples e robusta que a do UltraMSG):

1. **`POST /messages/text` da Whapi retorna `{ sent: true, message?: { id } }` (CONFIRMADO OpenAPI `SentMessage`).** `message.id` é o wamid síncrono quando presente.
2. `sendText` captura esse id e o devolve em `{ ok, messageId }`. O chat **já grava `messageId` como `whatsapp_id`** na linha outbound (mesmo caminho do UltraMSG).
3. Quando o eco `fromMe` chega pelo webhook, ele traz **o mesmo id**. A reconciliação acontece por **`whatsapp_id` + idempotência** (o núcleo já deduplica por `whatsapp_id`) — **sem** depender de `referenceId`.

O que **NÃO** funciona no dia-1 (declarar explícito, vira fase posterior):

- O caminho `tryReconcileFromMeByCrmReferenceId` (janela 15min por `crm-*`) **não** dispara para Whapi. Substituto = match por `whatsapp_id` capturado no envio. Se a resposta vier só com `sent: true` **sem** `message.id`, cai no fallback já existente (candidato por texto/mídia + janela).
- **Disparo/campanha** (`disp-*`): depende do worker rotear por instância (Fase E). Não mexer agora.
- ACK Whapi ↔ fila: `provider_queue_id` continua sendo o id numérico de fila do UltraMSG; para Whapi o id é wamid — o casamento de ACK usa `whatsapp_id` (o statusZapi já tem fallbacks). Não misturar os dois espaços de id.

Regra: **não criar campo `referenceId` fake na Whapi** e **não misturar** id numérico de fila UltraMSG com wamid Whapi.

---

## 5. Lista de arquivos NOVOS e papel de cada um

Ver §0.1. Papéis-chave:

- **`services/providers/whapi/index.js`** — API pública com os nomes do §2; monta os submódulos. Espelha o `ultramsg/index.js` em forma, **sem importar** nada da pasta ultramsg.
- **`services/providers/whapi/http.js`** — `buildBaseUrl` (`https://gate.whapi.cloud`), `Authorization: Bearer <token>`, `Content-Type: application/json`, timeout via AbortSignal, retry só-conexão, `maskTokenInLogs`.
- **`services/providers/whapi/config.js`** — `resolveConfig({companyId, whatsappInstanceId})` → busca instância (`getWhatsappInstanceById`, `includeCredentials:true, requireActive:true`), **recusa instância de outra empresa**, extrai `channel_id`=`instance_id` e `token`=`instance_token`. Sem prefixo `instance` (UltraMSG-only).
- **`services/providers/whapi/send.js`** — `sendText` real (Fase A); demais sends stub 501.
- **`services/providers/whapi/instanceAdmin.js`** — `getConnectionStatus` (`GET /health?wakeup=true`; `AUTH`/`CONNECTED`/`READY` ou `status.code === 4`); `configureWebhooks` real (`PATCH /settings` só `webhooks`, header `X-Webhook-Token`, URL `/webhooks/whapi` **sem** query token, `skipSendGuard`); `getLoginQr` (`GET /users/login/image` + fallback `GET /users/login`); `getLoginCode`; `logoutUser` (`POST /users/logout`). Nunca no boot, nunca na instância UltraMSG.
- **`services/providers/whapi/partner.js`** — Partner API (`manager.whapi.cloud`). `PUT /channels` com Bearer `WHAPI_PARTNER_TOKEN`. Não mistura com o token do canal / `gate.whapi.cloud`.
- **`controllers/webhookWhapiController.js`** — `normalizeWhapiToInternal(message)` + `normalizeWhapiStatus(status)` + `handleWebhookWhapi` (itera `messages[]`/`statuses[]`, delega a `receberZapi`/`statusZapi`). Espelha `handleWebhookUltramsg`, **sem** importar o controller UltraMSG.
- **`middleware/resolveWhapiWebhookCompany.js`** — extrai `channel_id`, `getWhatsappInstanceByProviderInstanceId('whapi', channelId)`, injeta `req.webhookContext`/`req.zapiContext` com `provider:'whapi'`. (Cópia enxuta do resolver UltraMSG parametrizada — não reescrever o de UltraMSG.)
- **`routes/webhookWhapiRoutes.js`** — stack `webhookLogger('whapi') → webhookBodyResolver → requireWhapiWebhookToken → resolveWhapiWebhookCompany → handleWebhookWhapi`.
- **`middleware/requireWhapiWebhookToken.js`** — auth dedicada do webhook Whapi: timing-safe, só header `X-Webhook-Token`/`Authorization: Bearer`, **sem `?token=`** e **sem** fallback por `instanceId` (não herda a vuln/cross-provider do `requireWebhookToken` UltraMSG). Fail-closed (env ausente → 500; token ruim → 401). Testes em `tests/whapiWebhookToken.test.js`.
- **migration** — `ALTER TABLE public.whatsapp_instances DROP CONSTRAINT whatsapp_instances_provider_chk; ADD CONSTRAINT whatsapp_instances_provider_chk CHECK (provider IN ('ultramsg','whapi'));` **NÃO aplicar.**

---

## 6. Fases de implementação (ordem + critério de pronto)

### Fase A — ✅ EXECUTADA (2026-09-04)

**Arquivos criados:** `services/providers/whapi.js` (shim) + `services/providers/whapi/{constants,result,http,config,phones,send,instanceAdmin,queries,index}.js`; `controllers/webhookWhapiController.js`; `middleware/resolveWhapiWebhookCompany.js`; `routes/webhookWhapiRoutes.js`; `supabase/migrations/20260904120000_whatsapp_instances_provider_whapi.sql` (**não aplicada**); testes `tests/{providerRouting,whapiProvider,whapiWebhook}.test.js`.
**Arquivos editados (aditivo):** `services/providers/index.js` (getProvider(opts), default ultramsg); `services/whatsappInstanceService.js` (allowlist `ultramsg|whapi`); `app.js` (monta `/webhooks/whapi`); `services/chat/identity/conversationAddressService.js` (`resolveConversationProvider`, default ultramsg); `controllers/chat/textMessageController.js` (só o envio de texto passa `getProvider({ provider })`).
**Gate:** suite completa **141 suites / 1463 testes verdes** (inclui 18 novos); gate UltraMSG+webhook 191/191. Regressão zero.
**Decisões de implementação (achados):**
- `handleWebhookWhapi` reusa o MESMO `req` e muta `req.body` entre itens de `messages[]`/`statuses[]`, dando `await` completo em cada handler antes do próximo (req.body estável durante cada `receberZapi`). Um item inbound que lança → HTTP **500** (reentrega; idempotência por whatsapp_id protege). ACK sempre 200.
- `sendText` Whapi: `POST /messages/text {to, body}`, Bearer no header (nunca na URL), retorno `{ok, messageId, error}`. `messageId` capturado da resposta síncrona = base da reconciliação (sem referenceId).
- `config.resolveConfig` tem **guarda de provider**: recusa instância que não seja `provider='whapi'` (não envia credencial UltraMSG pelo adapter Whapi).
- Mídia/sends não-texto = stub 501 (objeto `{ok:false, notImplemented, httpStatus:501}` ou `false`), nunca fingem sucesso.
**Contrato §3 (fechado 2026-09-04 via MCP+OpenAPI, sem send/settings):** `to` = dígitos (sufixo opcional); `messages[]`/`statuses[]` no formato oficial; send devolve `{ sent, message.id }`; `/health` = `{ status: { text: 'AUTH' }, user.id, channel_id }`.

### Fase B — ✅ EXECUTADA (2026-09-04) mídia inbound/outbound
- `sendImage/File/Audio/Voice/Video/Sticker/Reaction/Location/Contact` reais; `uploadMedia` (`POST /media`, data URI, `skipSendGuard`).
- HTTP ganhou `PUT` (reação: `PUT /messages/{id}/reaction`).
- Normalizador: `*.link` → `imageUrl`/`audioUrl`/… (pipeline já baixa via `inboundMediaPersistenceService`); reação oficial `type=action`; `link_preview`/`live_location`/`contact`; ACK `code`+`status`.
- **Mídia Whapi no visualizador (2026-09-07):** allowlist de inbound/proxy passa a aceitar `*.wasabisys.com` (auto-download Whapi) e `*.whapi.cloud`. Sem isso o `/media/proxy` devolvia 403, a bolha caía na URL direta e o lightbox (só a 1ª URL) mostrava o ícone quebrado “Imagem”. UltraMSG intocado.
- Chat: `mediaMessageController`, `outboundController`, `retryController`, `forwardController` passam `getProvider({ provider })` (default ultramsg).
- **Ainda stub 501:** `clearChatMessages`, `resendByStatus`/`resendById`, `getMessagesStatistics`, `clearMessages`.
- **sendCall (2026-09-07):** POST `/calls/outgoing` `{to,duration}` (makeCall). Botão Ligar do perfil dispara `POST /chats/:id/ligacao`. 503 ativa `outgoing_calls_enabled` e retenta uma vez. UltraMSG continua sem chamada WhatsApp (`tel:` no perfil).
- **Opcionais implementados (2026-09-07, código; live PENDENTE):** `forwardMessage` (POST `/messages/{MessageID}`), `checkPhones` (POST `/contacts`), `getLoginQr` (GET `/users/login/image` → dataURI). Testes em `tests/whapiOptionalEndpoints.test.js`.
  - **Fiação HTTP (aditiva, provider-aware):** `getLoginQr` → `GET /integrations/whatsapp/instances/:id/qrcode` (substituiu o 501; formato UltraMSG). `checkPhones` → **novo** `POST /integrations/whatsapp/instances/:id/check-phones` `{ phones:[], forceCheck? }` → `{ total, validCount, invalidCount, results:[{input,exists,waId}] }`; provider sem `checkPhones` → 501; **não** toca o loop de disparo. `forwardMessage` → **fiado (2026-09-07)** no `forwardController` como fast-path com fallback: só encaminha nativo quando `provider.forwardMessage` existe (Whapi), a origem tem `whatsapp_id` real E é da MESMA instância; caso contrário (UltraMSG, id ausente, instância diferente, ou falha do nativo) mantém a cópia atual. Preserva o selo "Encaminhada" e evita duplicar. Testes em `tests/whapiForwardNative.test.js` (função exposta via `_test`).
- **Lote de endpoints extras (2026-09-07, código+testes; live PENDENTE):** adapter Whapi ganhou (paths confirmados no OpenAPI):
  - `pinMessage` POST `/messages/{id}/pin` `{time:day|week|month}`; `starMessage` PUT `/messages/{id}/star` `{starred}`; `markMessageAsPlayed` PUT `/messages/{id}/played`.
  - `patchChat` PATCH `/chats/{id}` `{pin?,mute_until?,mark_unread?,ephemeral?}` (+ atalhos `pinChat`/`muteChat`).
  - `getContactAbout` GET `/contacts/{id}/about`; `addContact` PUT `/contacts` `{phone,name}`; `getIdByLid` GET `/contacts/ids/{lid}`; `getLidById` GET `/contacts/lids/{id}`.
  - **Lote doc Contacts/Messages (2026-09-07, adapter-only):** `checkExist` HEAD `/contacts/{id}`; `editContact` PATCH `/contacts/{id}` `{name}`; `deleteContact` DELETE `/contacts/{id}`; `getLidByIds` GET `/contacts/lids?ContactIDList=`; `sendGif` POST `/messages/gif`; `sendShortVideo`/`sendPtv` POST `/messages/short`; `sendLiveLocation` POST `/messages/live_location`. Testes: `tests/whapiDocEndpoints.test.js`. **Não** fiados em lista/thread/composer.
  - `getLoginCode` GET `/users/login/{phone}` → `{code}` (pareamento sem QR) → fiado em **novo** `POST /integrations/whatsapp/instances/:id/phone-code` (só Whapi; UltraMSG segue em `/connect/phone-code`).
  - `sendLink` melhorado: usa POST `/messages/link_preview` (card com título/mídia) quando há título; senão texto simples (que já previa a URL); fallback resiliente a texto.
  - Testes: `tests/whapiExtraEndpoints.test.js` (14). Todos exportados via `getProvider({provider}).*`. **Adapter-only** (exceto phone-code fiado); pin/star/patchChat/about/addContact aguardam UI/menu-bolha para consumo.
- **Homologação live texto (CONFIRMADO 2026-09-04):** empresa `30`, instância `30`, canal `NEBULA-AER3B`. Atendimento enviou/recebeu texto (conversa Otavio, ACK/ticks). Mídia/delete/edit/sync/disparo Whapi: código real, homologação live **PENDENTE**. Rotacionar JWT/Bearer/webhook token (vazaram na sessão).
- **Pronto de código quando:** testes Whapi + gate UltraMSG verdes. Live só com autorização.

### Fase C — painel conexão Whapi (health/QR pairing) + UI mínima cadastro — **parcial 2026-09-04**

**Feito (backend, sem PATCH live, sem UI):**
- `configureWebhooks` Whapi: `PATCH https://gate.whapi.cloud/settings` com `{ webhooks: [{ url: APP_URL/webhooks/whapi, mode: 'body', events: messages post/put/patch/delete + statuses post/put, headers: { X-Webhook-Token: WHATSAPP_WEBHOOK_TOKEN } }] }`. Recusa se o token de webhook estiver ausente. Não dispara send-guard.
- `POST /integrations/whatsapp/instances/:id/configure-webhooks` e o company-level `POST .../configure-webhooks` roteiam pelo provider da instância. Company-level: **UltraMSG primeiro**; Whapi só se a empresa não tiver default UltraMSG.
- `GET /instances/:id/status` em instância Whapi chama `GET /health` do adapter (não o QR/status UltraMSG).
- `GET /instances/:id/qrcode` em instância Whapi (2026-09-07): chama `getLoginQr` (`GET /users/login/image`) e devolve `{ imageBase64, qrBase64, dataUri }` no **mesmo formato do UltraMSG** (base64 cru; front prefixa `data:`). Se não houver QR, consulta `getConnectionStatus`: canal em AUTH → `{ alreadyConnected:true }`; senão 502 com erro claro. `POST .../restart` Whapi segue **501** (sessão gerida pelo canal). Caminho UltraMSG intocado.
- HTTP Whapi ganhou `PATCH` (`skipSendGuard` em settings) e `getBinary` (leitura de bytes p/ o QR).

**Ainda falta (C restante):** homologação live do QR/pairing (PENDENTE). UI SaaS **2026-09-07:** aba Configurações `?tab=whapi` consulta health na lista (`GET /health?wakeup=true`, `AUTH`/`code 4` = conectado), auto-seleciona a instância e gera QR se precisar. `POST /instances/provision-whapi` cria o canal via Partner (`PUT manager.whapi.cloud/channels`) — o usuário **não** cola Channel ID/token. Cadastro manual ficou em “avançado”. Passkeys Chrome/NID **fora**.

Health: `getConnectionStatus` manda `wakeup=true` por padrão (canal adormecido deixava o painel em “Desconectado”). `wakeup:false` só em checagens que não devem acordar o canal.

Partner (CONFIRMADO na doc oficial): Bearer `WHAPI_PARTNER_TOKEN`; body `{ name, projectId }`; resposta `{ id, token, apiUrl }`. Token do canal **não** volta no JSON da API ZapERP. Sem Partner configurado → `503` `WHAPI_PARTNER_OFF`. Idempotente se a empresa já tem instância Whapi.

**Pronto de C quando:** criar instância Whapi pela UI, ver health, configurar webhook, sem quebrar fluxo UltraMSG.

### Homologação send/receive (o que ainda impede o teste ao vivo)

Ordem obrigatória (não inverter):

1. **Migration** `20260904120000_whatsapp_instances_provider_whapi.sql` no banco (sem ela o INSERT `provider='whapi'` cai na CHECK).
2. **Deploy** deste código na VPS (`POST /webhooks/whapi` não existe na API antiga).
3. **Cadastrar instância** `POST /integrations/whatsapp/instances` com `{ provider: 'whapi', instance_id: 'NEBULA-AER3B', instance_token: '<Bearer do canal>', nome: 'Whapi teste' }` (`channel_id` também vale). **Não** enviar `is_default: true` se a empresa já tem UltraMSG default. Preferir empresa de teste. Não cadastrar o **mesmo número** nas duas APIs ao mesmo tempo.
4. **Apontar webhook** `POST /integrations/whatsapp/instances/:id/configure-webhooks` (exige `APP_URL` + `WHATSAPP_WEBHOOK_TOKEN`). Ou no painel Whapi: URL `{APP_URL}/webhooks/whapi`, header `X-Webhook-Token`, **sem** `?token=`.
5. **Conversar** numa conversa cujo `whatsapp_instance_id` é essa instância (senão o chat envia pela UltraMSG).
6. Enviar texto no CRM → adapter `POST /messages/text`. Receber no celular → Whapi POST `/webhooks/whapi` → `receberZapi`. Eco `from_me` também entra no pipeline (unread 0). ACK em `statuses[]`.
7. Rotacionar token do canal **depois**.

**Não feito nesta sessão (precisa autorização explícita):** aplicar migration, PATCH live no canal, deploy, commit/push, enviar WhatsApp real.

### Fase D — sync contatos/grupos/histórico — **EXECUTADA 2026-09-04 (código; live PENDENTE)**
- `getContacts` GET `/contacts` (paginação count/offset) → `{ data, hasMore, rawCount }` via `agendaContactFields`.
- `getChats` GET `/chats`; `getGroups` GET `/groups`; `getGroup` GET `/groups/{id}`.
- `getChatMessages` GET `/messages/list/{ChatID}` mapeado para o formato que `oldMessagesSyncService` já lê (`from_me`, `text.body`, `image.link`).
- Foto no atendimento: `syncUltraMsgContact` em provider Whapi chama `GET /contacts/{id}/profile` **mesmo sem** o contato na agenda (`getContactMetadata` nulo). UltraMSG segue exigindo metadata antes da imagem. Novo contato e abrir conversa passam `whatsapp_instance_id`. Inbound `@lid` não é mais convertido em dígitos de telefone.
- `getProfilePicture` GET `/contacts/{digits}/profile` (`icon_full`); grupo via GET `/groups/{id}`.
- Callers de sync (`oldMessagesSyncService`, `contactSyncService`, `ultramsgContactsSyncService`, `ultramsgGroupsSyncService`, `syncFotosProgressivaService`) passam `getProvider({ provider })` por instância/empresa. Default continua ultramsg.
- `getEmpresaWhatsappConfig` (legado UltraMSG / default `provider=ultramsg`) é ignorado quando o provider da empresa/instância é Whapi — **CONFIRMADO 2026-09-05**: o gate existia em grupos/chats e **faltava** em `syncUltraMsgContact`, `contactSyncService`, `ultramsgContactsSyncService` e `POST /chats` sync de agenda. Sem isso, empresa só-Whapi (ex. instância 30) falhava com "sem instância" mesmo com o adapter Whapi roteado.
- `resolveConversationWhatsappInstance` **não** chama mais `getDefaultWhatsappInstance` primeiro. Essa função filtra `provider=ultramsg` e, se vazio, cai em `empresa_zapi` **mesmo com linha Whapi na mesma empresa**. Agora: lista `whatsapp_instances` da empresa → `is_default` ou única ativa (qualquer provider) → só então legado se **zero** ativas. Teste: `tests/conversationAddressInstance.test.js`.

### Fase E — disparo/campanha na instância Whapi — **roteamento EXECUTADO 2026-09-04**
- `disparoSendService` e `disparoOptOutService` usam `getProvider({ provider })` da instância da campanha (`item.instancia_id`). Flags dry-run/live **não mudam**. Pasta `ultramsg/` intocada.
- Chatbot inbound, encerrar atendimento, alertas, jobs de inatividade, reconciliação pending e apagar mensagem também roteiam por instância.
- `editMessage` no adapter Whapi (POST `/messages/text` + `edit`) e **rota HTTP** `PATCH /chats/:id/mensagens/:mensagem_id` (`messageEditController.js`). Texto e **legenda** de imagem/vídeo/arquivo (não troca o arquivo; áudio/sticker/contato/localização recusados). Janela 15 min; só `direcao=out` do autor (admin pode editar outbound de outro). UltraMSG → 422 `EDIT_NOT_SUPPORTED` (adapter sem `editMessage`; pasta `ultramsg/` intocada). Nota interna edita só no CRM. Campos `mensagens.editada` / `editada_em` (migration `20260907220000_mensagens_editada.sql`, **não aplicada**). GET `/chats/:id` devolve `editada` + alias `editado`. Socket `mensagem_editada` inclui `texto`, `editado`, `editada_em`, `company_id`, `ultima_mensagem`. Webhook Whapi `edited:true` (texto ou caption de mídia) atualiza a linha e emite o mesmo evento.

---

## 7. Riscos de regressão na UltraMSG (meta: zero se `provider=ultramsg`)

| Vetor | Mitigação |
|---|---|
| `getProvider()` mudar retorno para callers atuais | no-arg e default **→ ultramsg**; teste trava isso |
| `jest.mock('../services/providers/ultramsg')` | path e shim intactos; whapi é outro path |
| `resolveConfig`/JID unificados | proibido; whapi tem `config.js`/`phones.js` próprios |
| Webhook UltraMSG afetado | rota, controller, resolver e alias `/webhooks/whatsapp` **não** tocados; whapi é rota nova |
| `normalizeProvider` rejeitar ultramsg | allowlist inclui ultramsg; desconhecido→ultramsg (não lança) |
| Migration inverter ordem | migration aplicada **antes** do deploy; sem ela, criar instância whapi falha na CHECK (não afeta ultramsg) |
| Disparo de produção | roteamento aditivo por `instancia_id`; `getProvider()` no-arg continua ultramsg; flags dry-run/live iguais |

---

## 8. Como testar sem atingir cliente

- **Jest, fetch mockado, sem token real, sem número de cliente.** Casos mínimos: default getProvider=ultramsg; provider='whapi' roteia whapi; isolamento empresa A×B; webhook whapi inbound + ACK; `sendText` Bearer+JSON; instância ultramsg não passa pelo adapter whapi; stub 501 não finge sucesso.
- **Gate obrigatório:** rodar as suites UltraMSG/webhook atuais (doc 21 §10 e doc 24 §6) — verdes.
- **MCP `user-whapi-mcp`** só para **inspecionar contrato** (`checkHealth` `wakeup:false`, `getChannelSettings` GET, schemas). **Proibido** `sendMessage*`, `updateChannelSettings`, `webhookTest`, login/QR via MCP.
- **Homologação live:** só com autorização explícita, tenant/número de teste, allowlist e teto. `PATCH /settings` (webhook) só em homologação.

---

## 9. O que NÃO fazer (anti-padrões desta tarefa)

- ❌ Editar/refatorar qualquer arquivo da UltraMSG (`providers/ultramsg*`, `webhookUltramsgController`, `ultramsgIntegrationController`/`Service`, rotas ultramsg, alias `/webhooks/whatsapp`).
- ❌ Apontar `/webhooks/whatsapp` para Whapi (é UltraMSG).
- ❌ Unificar adapter, JID, ou normalizador num "provider genérico".
- ❌ Inventar `referenceId` na Whapi; misturar id de fila numérico com wamid.
- ❌ MCP no runtime do adapter; send/settings via MCP.
- ❌ Fatiar/renomear/mover `receberZapi`/`statusZapi` (sem o mapa do doc 24).
- ❌ `company_id` de body/query; auth de webhook por `?token=`.
- ❌ Chamar UltraMSG por engano em sync/envio de instância whapi.
- ❌ Aplicar migration, commitar, pushar, deploy, mexer em `.env` de produção, enviar mensagem real, QR/restart/settings em canal de cliente.

---

## 10. Achados do código (CONFIRMADO nesta sessão)

### Auditoria de instâncias (2026-09-05) — o que estava certo vs o que quebrava

**Certo (código, não docs):**
- `getProvider({ provider })` no-arg → UltraMSG. Só `'whapi'` vai ao adapter Whapi.
- Envio texto/mídia/delete/retry/forward/disparo: `resolveConversationProvider(company_id, whatsappInstanceId)` → adapter. Conversa **com** `whatsapp_instance_id` Whapi usa Whapi (homologação texto 1:1 da empresa 30).
- Webhook `POST /webhooks/whapi` → `resolveWhapiWebhookCompany` injeta `provider='whapi'` + `whatsapp_instance_id` pelo `channel_id` (`getWhatsappInstanceByProviderInstanceId('whapi', …)`). `receberZapi` **não** re-resolve como ultramsg se o contexto já tem `company_id`.
- Adapter Whapi `resolveConfig` recusa instância que não seja `provider='whapi'`.
- Abrir conversa manual (`resolveWhatsappInstanceForManualAction`) já listava **todas** as instâncias ativas (não filtrava ultramsg) — 1 Whapi ativa é adotada.

**Bug real corrigido nesta sessão:**
- Conversa **sem** `whatsapp_instance_id` numa empresa só-Whapi: `getDefaultWhatsappInstance(company_id)` (default ultramsg) → vazio → `empresa_zapi` ou `null` → `resolveConversationProvider` caía em UltraMSG. Envio/delete/encerrar iam para o adapter errado. Inbound homologado mascarava isso porque o webhook já grava a instância 30.
- Enrichment de nome/foto (`syncUltraMsgContact`) exigia `getEmpresaWhatsappConfig` (só default UltraMSG) **depois** de já ter roteado o adapter Whapi → return null em empresa só-Whapi.

**Auditoria 2026-09-07 (código):**
- Adapter UltraMSG `resolveConfig` agora recusa `provider=whapi` (simétrico à guarda Whapi). Teste: `tests/ultramsgConfigGuard.test.js`.
- `toWhapiChatId` converte `@c.us` (UltraMSG) para `@s.whatsapp.net`. Teste: `tests/whapiPhones.test.js`.
- Webhook Whapi: `getWhatsappInstanceByProviderInstanceId(..., { allowLegacyFallback: false })` — não casa `empresa_zapi`.
- `GET /chats` status e debug-sync: empresa só-Whapi não cai mais no gate UltraMSG/`empresa_zapi`.
- Histórico (`resolveOldMessagesWhatsappInstanceId`) usa `pickInstanceForUnboundConversation` (não pega a primeira instância em empresa mista sem default).

---

- `services/providers/index.js` (14 linhas): `getProvider()` devolve sempre ultramsg. **Único ponto** a tornar consciente de `opts.provider`.
- **Todos os `getProvider()` são sem-argumento** (chat/config/ia/jobs/whatsappIntegration/webhookInbound). Trocar para `{ provider }` é aditivo e local — cada caller **já tem `whatsappInstanceId`/instância em escopo** (ex. `outboundController` linha 59/70).
- `whatsappInstanceService.getWhatsappInstanceByProviderInstanceId(provider, id)` **já filtra `.eq('provider', p)`** e trata `DUPLICATE_PROVIDER_INSTANCE`. Um resolver whapi só chama com `'whapi'`.
- `resolveWebhookCompany.js` está **hardcoded `'ultramsg'`** (não agnóstico) → resolver whapi **novo** (não editar o de ultramsg).
- `webhookBodyResolver`/`webhookLogger` são **agnósticos** → reusados na stack whapi. `requireWebhookToken` **não** é reusado: a Whapi tem `requireWhapiWebhookToken` dedicado (sem `?token=`, sem fallback por instanceId) — o compartilhado ficou intacto para o UltraMSG.
- CHECK atual: `whatsapp_instances_provider_chk CHECK (provider IN ('ultramsg'))` em `supabase/migrations/20260615000000_whatsapp_instances_phase1.sql`. Unique `(company_id, provider, instance_id)` já existe. Migration Whapi **escrita, não aplicada**.
- `webhookUltramsgController.handleWebhookUltramsg` é o **template exato** a espelhar: normaliza envelope → `webhookCoreController.statusZapi`/`receberZapi`.
- **MCP 2026-09-05:** canal `NEBULA-AER3B` status AUTH. Webhook do canal aponta para `POST /webhooks/whapi` (eventos `messages` post/put/patch/delete + `statuses` post/put). **Não** repetir token de header em logs/docs.
- Painel: `whatsappIntegrationController` roteia status/QR/restart/configure-webhooks **por instância**. QR Whapi = `getLoginQr` (PNG + fallback JSON). Restart Whapi = 501. Logout Whapi = `POST /instances/:id/logout`. Company-level configure-webhooks = UltraMSG primeiro.

---

## 11. Inventário MCP Whapi × adapter ZapERP (2026-09-05)

MCP `user-whapi-mcp`: **187 tools**. O CRM **não** precisa de todos. Critério: paridade com o que o ZapERP já faz via UltraMSG (`services/providers/ultramsg/index.js`).

### Implantado no adapter (HTTP real, não stub)

| ZapERP | MCP / HTTP Whapi |
|---|---|
| `sendText` (+ `edit` / `quoted`) | `sendMessageText` POST `/messages/text` |
| `sendImage` `sendVideo` `sendFile` `sendAudio` `sendVoice` `sendSticker` | `sendMessageImage/Video/Document/Audio/Voice/Sticker` |
| `sendLink` | `sendMessageLinkPreview` (via texto/link) |
| `sendContact` `sendLocation` | `sendMessageContact` `sendMessageLocation` |
| `sendReaction` `removeReaction` | `reactToMessage` `removeReactFromMessage` |
| `deleteMessage` `markMessageAsRead` `getMessages` | `deleteMessage` `markMessageAsRead` `getMessages`/`getMessage` |
| `getChatMessages` | `getMessagesByChatID` GET `/messages/list/{ChatID}` |
| `archiveChat` `readChat` `deleteChat` `getChats` | `archiveChat` `patchChat` `deleteChat` `getChats` |
| `getContacts` `getContactMetadata` `getProfilePicture` | `getContacts` `getContact` `getContactProfile` |
| `getGroups` `getGroup` | `getGroups` `getGroup` |
| `uploadMedia` | `uploadMedia` POST `/media` |
| `getConnectionStatus` | `checkHealth` GET `/health` |
| `configureWebhooks` | `updateChannelSettings` PATCH `/settings` |
| `updateProfileName/Picture/Description` | `updateUserProfile` PATCH `/users/profile` |

Webhook inbound: texto, from_me, ACK, mídia `link`, reação `action`, edit, location, contact. Deleted inbound é ignorado (igual UltraMSG).

### Stub 501 / não existe no CRM

| Adapter | MCP equivalente | Precisa no ZapERP? |
|---|---|---|
| `sendCall` | `makeCall` POST `/calls/outgoing` | Sim — botão Ligar no perfil (Whapi); UltraMSG não tem endpoint equivalente |
| `clearChatMessages` `clearMessages` `resendBy*` `getMessagesStatistics` | não há equivalente 1:1 | Não — UltraMSG-only |

**Implementados 2026-09-07 (saíram do 501):** `getLoginQr` (`loginUserImage`), `forwardMessage`, `checkPhones` — ver §Fase D e `tests/whapiOptionalEndpoints.test.js`. Código pronto; falta ligar a controller/UI e homologar ao vivo.

### Existe no MCP, **não** implantado — só se o produto pedir

**Atendimento (gap vs canal, não vs UltraMSG):** `commentMessage`; `getPresence`. (`patchChat`/`starMessage`/`pinMessage`/`markMessageAsPlayed`/`checkExist`/`getLidById`/`getIdByLid`/`getLidByIds`/`addContact`/`editContact`/`deleteContact` já no adapter — UI/menu ainda PENDENTE salvo o que já está fiado.)

**Envio extra (WhatsApp tem, CRM não usa):** `sendMessagePoll` `sendMessageQuiz` `sendMessageQuestion` `sendMessageCarousel` `sendMessageContactList` `sendMediaMessage` (multipart). `sendGif`/`sendShortVideo`/`sendLiveLocation` e `sendInteractive` estão no adapter; composer do atendimento **não** os dispara ainda.

**Fora de escopo CRM (não implantar sem pedido):** stories, newsletters/canais, comunidades, catálogo/produtos/coleções, labels Business, bots, `createCallEvent`/`createGroupCallLink`, agrupamento admin (criar grupo, promover, convite), login/logout/reset settings. Blacklist **já no adapter** (`blockContact`/`unblockContact`/`getBlacklist`) — ver §26.2. `makeCall` **está** fiado no botão Ligar.

Webhook: canal **não** assina chats/contacts/groups/presences/calls. Só messages+statuses. Não tratar o resto até assinar.

Homologação live ainda pendente além de texto 1:1: mídia, delete, edit, sync, disparo.

---

## 26. Recursos de valor (além de paridade) — presença + block no opt-out (2026-09-07)

Implementados (adapter + gancho, **sem frontend**, UltraMSG intocável). Contrato confirmado via MCP.

### 26.1 Presença "digitando…" — UX humana no atendimento
- Adapter `services/providers/whapi/presence.js`:
  - `sendPresence(phone, presence, { companyId, whatsappInstanceId, delay })` → `PUT /presences/{EntryID}` `{ presence, delay? }`. Presenças de chat: `typing | recording | paused` (validado; inválido = no-op). `delay` clampado 0–25s. `skipSendGuard` (sinal leve, não consome rate de envio).
  - `setMePresence('online'|'offline', opts)` → `PUT /presences/me`.
- Gancho: `controllers/chat/textMessageController.js` dispara `provider.sendPresence(..., 'typing')` **fire-and-forget e guardado** (`typeof provider.sendPresence === 'function'`) logo antes do envio de texto/link. UltraMSG não tem `sendPresence` → no-op. Nunca bloqueia nem faz throw no envio real.
- Envs: `WHAPI_TYPING_INDICATOR_ENABLED` (default `true`), `WHAPI_TYPING_INDICATOR_DELAY_S` (default `3`).

### 26.2 Blacklist / bloquear no opt-out — efeito real do opt-out
- Adapter `services/providers/whapi/blacklist.js`: `blockContact` (`PUT /blacklist/{id}`), `unblockContact` (`DELETE /blacklist/{id}`), `getBlacklist` (`GET /blacklist`). Retorno `{ ok, error? }` / array.
- Gancho: `services/disparoOptOutService.js` → `bloquearContatoNoWhatsapp()` chamado em `processInboundOptOut` (fluxo vivo via `webhookInbound/disparoInbound.js`). Gate triplo, **opt-in e seguro**:
  1. env `WHAPI_OPTOUT_BLOCK_ENABLED` (**default `false`** — sem ele, comportamento idêntico ao de hoje: opt-out só registra exclusão no CRM);
  2. `getDisparoFlags().canSendLive` (dry-run **nunca** bloqueia);
  3. provider suporta `blockContact` (Whapi sim; UltraMSG não → no-op).
  - `processInboundOptOut` agora retorna também `{ blocked, blockReason }`.
- **Ressalva de produto:** bloquear impede TODA comunicação (não só marketing) — por isso é opt-in por env. Um flag por empresa em `disparo_empresa_config` (coluna nova + migration) é o refino futuro se quiser granularidade por tenant.

### 26.3 Não implementado (planejar à parte)
- **Mensagens interativas** (`POST /messages/interactive` — botões/listas): maior valor, mas é feature completa (backend + frontend + normalização de resposta no webhook). Planejar em doc próprio.
- **Labels** Business (`/labels` + associação a chat): integrar com o sistema de tags/kanban existente. Depois.

### 26.4 Testes / gate
`tests/whapiPresenceBlacklist.test.js` (10) + `tests/disparoOptOutBlock.test.js` (5). Suite completa **152 suites / 1568 testes verdes**. Regressão zero.
Homologação live pendente (presença e block ainda não exercidos contra canal real).

### 26.5 Certificação das telas da doc Whapi (Contacts / Messages / Blacklist) — 2026-09-07

Todos no adapter `getProvider({ provider: 'whapi' })`. Homologação live **PENDENTE**. Composer/lista **não** ganhos de UI neste lote.

| Doc | Método HTTP | Path Whapi | Adapter |
|---|---|---|---|
| Get contacts | GET | `/contacts` | `getContacts` |
| Check phones | POST | `/contacts` `{contacts}` | `checkPhones` |
| Get contact | GET | `/contacts/{id}` | `getContactMetadata` |
| Add contact | PUT | `/contacts` | `addContact` |
| Send contact | POST | `/messages/contact` | `sendContact` |
| Check exist | HEAD | `/contacts/{id}` | `checkExist` |
| Get LIDs by IDs | GET | `/contacts/lids?ContactIDList=` | `getLidByIds` |
| Edit contact | PATCH | `/contacts/{id}` `{name}` | `editContact` |
| Get LID by ID | GET | `/contacts/lids/{id}` | `getLidById` |
| Delete contact | DELETE | `/contacts/{id}` | `deleteContact` |
| Get contact about | GET | `/contacts/{id}/about` | `getContactAbout` |
| Get ID by LID | GET | `/contacts/ids/{lid}` | `getIdByLid` |
| Get messages by chat ID | GET | `/messages/list/{ChatID}` | `getChatMessages` |
| Send text | POST | `/messages/text` | `sendText` |
| Send image/video/audio/voice/document | POST | `/messages/{image\|video\|audio\|voice\|document}` | `sendImage`/`sendVideo`/`sendAudio`/`sendVoice`/`sendFile` |
| Send GIF | POST | `/messages/gif` | `sendGif` |
| Send short/PTV | POST | `/messages/short` | `sendShortVideo` (`sendPtv`) |
| Send link preview | POST | `/messages/link_preview` | `sendLink` (com título) |
| Send location | POST | `/messages/location` | `sendLocation` |
| Send live location | POST | `/messages/live_location` | `sendLiveLocation` |
| Send contact | POST | `/messages/contact` | `sendContact` |
| Add/remove/get blacklist | PUT/DELETE/GET | `/blacklist` `/blacklist/{id}` | `blockContact` `unblockContact` `getBlacklist` |

Testes: `tests/whapiDocEndpoints.test.js`. `HEAD` em `http.js` (sem corpo, sem send-guard). HEAD/PATCH/DELETE de contato usam `skipSendGuard` (não enviam WhatsApp).

### 26.6 Certificação Media / Users / Channel (doc Whapi) — 2026-09-07

Adapter-only (`getProvider({ provider: 'whapi' })`). Homologação live **PENDENTE**. `DELETE /settings` exige `confirm:true` (apaga webhooks). UltraMSG / lista / thread / composer **intocados**.

| Doc | Método HTTP | Path Whapi | Adapter |
|---|---|---|---|
| Upload media | POST | `/media` | `uploadMedia` |
| Get media files | GET | `/media` | `getMediaFiles` |
| Get media | GET | `/media/{MediaID}` | `getMedia` |
| Delete media | DELETE | `/media/{MediaID}` | `deleteMedia` |
| Login QR-base64 | GET | `/users/login` | `getLoginQrBase64` (o painel usa `getLoginQr` = PNG + fallback) |
| Login QR-image | GET | `/users/login/image` | `getLoginQr` |
| Login QR-rowdata | GET | `/users/login/rowdata` | `getLoginQrRowData` |
| Auth code | GET | `/users/login/{phone}` | `getLoginCode` |
| Logout | POST | `/users/logout` | `logoutUser` |
| User info | GET | `/users/profile` | `getUserProfile` |
| Get profile | GET | `/contacts/{id}/profile` | `getContactProfile` (`getProfilePicture` já usava este path) |
| Update user info | PATCH | `/users/profile` | `updateUserProfile` (+ atalhos name/icon/about) |
| Registration date | GET | `/users/account/registration_date` | `getAccountRegistrationDate` |
| Get username | GET | `/users/username` | `getUsername` |
| Set username | PATCH | `/users/username` | `setUsername` |
| Health & launch | GET | `/health?wakeup=true` | `getConnectionStatus` |
| Get settings | GET | `/settings` | `getChannelSettings` |
| Reset settings | DELETE | `/settings` | `resetChannelSettings` (`confirm:true`) |
| Update settings | PATCH | `/settings` | `updateChannelSettings` (campos omitidos inalterados; `configureWebhooks` continua o caminho do produto) |
| Allowed events | GET | `/settings/events` | `getAllowedEvents` |
| Test webhook | POST | `/settings/webhook_test` | `testWebhook` |
| Get limits | GET | `/limits` | `getLimits` (HTTP 204 = sem limite) |

Testes: `tests/whapiMediaUsersChannel.test.js`.

---

## 27. Mensagens interativas — BACKEND executado + plano do frontend (2026-09-07)

Feature classificada como "completa (backend+frontend)". **Backend feito**; frontend do compositor = plano à parte (abaixo).

### 27.1 Envio (feito)
- `services/providers/whapi/send.js` → `sendInteractive(phone, payload, opts)` → `POST /messages/interactive`.
  - `payload`: `{ type:'button'|'list'|'product', body, header?, footer?, action }`. `body/header/footer` aceitam string ou `{text}`. Valida type/body/action antes de chamar a API (não finge sucesso). Retorna `{ ok, messageId, error }` (objeto, como sendText). `applyQuoted` suportado.
  - Exportado no `whapi/index.js` como `sendInteractive`. UltraMSG **não** ganhou o método → chamadas só fazem sentido via `getProvider({ provider:'whapi' })`.
  - Contrato MCP `sendMessageInteractive`: `button` → `action.buttons[{type:quick_reply|url|call|copy, title, id}]`; `list` → `action.list.sections[].rows[]` + `action.label`. **Ressalva do provedor:** botões no WhatsApp são instáveis (aviso oficial Whapi). Polls (`/messages/poll`) são a alternativa recomendada por eles — não implementado (fora do pedido).

### 27.2 Resposta inbound (feito — o pedaço que automatiza triagem)
- `controllers/webhookWhapiController.js` → `extractInteractiveReply(m)` lê `m.reply`/`m.interactive` (`buttons_reply`/`list_reply`/`button_reply`) → `{ id, title, description }`.
- `normalizeWhapiMessageToInternal`: `type` `reply`/`interactive` → **internalType `chat`**, `body`/`text.message` = título escolhido (a URA/chatbot trata como resposta digitada), e carrega `interactiveReplyId`/`interactiveReplyTitle` para casamento exato futuro.
- **PENDENTE (homologação live):** confirmar o shape exato do inbound de resposta (buttons_reply vs button_reply, campo do id). O extractor tolera as variações conhecidas; ajustar se o canal real divergir.

### 27.3 Frontend — PLANO À PARTE (não implementado)
Zona sensível (composer/scroll/teclado — não tocar às cegas). Escopo mínimo sugerido, isolado do fluxo de texto atual:
1. **Autoria (opcional, fase 2):** um botão "Enviar menu" no composer que abre um modal para montar botões/lista (título + até 3 botões, ou seções/linhas). Enviar via novo endpoint backend `POST /chats/:id/interactive` (a criar) que chama `getProvider({provider}).sendInteractive`. NÃO alterar o envio de texto.
2. **Exibição:** a mensagem interativa enviada aparece como bolha de texto normal (o `body.text` já vira o texto persistido) — no MVP não precisa render especial. A **resposta** do cliente já chega como texto normal (internalType chat) → aparece sem mudança de UI.
3. **Guarda:** feature só visível/possível quando a instância da conversa é `provider='whapi'` (checar via dado já existente `whatsapp_instance_id`/provider). UltraMSG não expõe o botão.
Ordem recomendada: exibição já funciona de graça; só a **autoria** (modal + endpoint) é trabalho real. Sizing: ~1 endpoint backend + 1 modal frontend, sem tocar lista/thread/scroll.

### 27.4 Testes / gate
`tests/whapiInteractive.test.js` (7): envio botão/lista, validação sem chamar API, `extractInteractiveReply` (buttons_reply/list_reply), resposta→inbound chat, mensagem normal sem campos interativos. Suite completa **1575 testes verdes**. Regressão zero.

### 27.5 Labels (ainda não implementado — próximo da lista de valor)
`GET/POST /labels` + associação a chat (`addLabelAssociation`/`deleteLabelAssociation`/`getLabelAssociations` no MCP). Casar com o sistema de tags/kanban existente do CRM. Fica para a próxima rodada de valor.
