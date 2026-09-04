# 25 — Whapi Cloud: segunda integração WhatsApp (aditiva, UltraMSG intocável)

> Criado: **2026-09-03**. **Fase A EXECUTADA em 2026-09-04**. **Fase B EXECUTADA em 2026-09-04** (mídia + contrato MCP fechado). **Fase C parcial EXECUTADA em 2026-09-04** (`configureWebhooks` real + roteamento de status/QR/restart por instância). QR/pairing e UI de cadastro ainda plano. Fases D–E ainda plano.
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
  upload.js           ← POST /media (Fase B)
  instanceAdmin.js    ← getConnectionStatus/health/QR-pairing/configureWebhooks
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
 Whapi POST     ─► /webhooks/whapi     ─► requireWebhookToken ─► resolveWhapiWebhookCompany('whapi')   NÚCLEO ATIVO
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
| `sendCall` | só se o produto usar (INFERÊNCIA: não usado no chat) | stub |

`opts` sempre carrega `{ companyId, whatsappInstanceId, referenceId?, returnDetails? }`.
**HTTP 401/403 / `sent=false` NÃO é sucesso** → `normalizeWhapiSendResult` exige id de mensagem ou flag de sucesso.

### 2.2 Chat admin / consultas / instância (mapa completo, stub até a fase)

| Grupo | Métodos | Whapi Fase |
|---|---|---|
| Chat admin | `deleteMessage, archiveChat, unarchiveChat, readChat, clearChatMessages, deleteChat` | B/D (stub antes) |
| Consultas | `getContacts, getChats, getGroups, getGroup, getChatMessages, getProfilePicture, getContactMetadata, uploadMedia` | D (stub antes) |
| Instância | `getConnectionStatus, configureWebhooks` + **health** + **QR/pairing** (equivalente Whapi de sessão WhatsApp Web) | A(health) / **C parcial (configureWebhooks real; QR 501)** |

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

**Auth webhook:** reusar `requireWebhookToken` (timing-safe, `WHATSAPP_WEBHOOK_TOKEN`) via **header** `X-Webhook-Token` ou `Authorization: Bearer` — **nunca `?token=` na query** (vuln de log já conhecida). Se a Whapi mandar header próprio de assinatura, validar adicionalmente. Tenant **sempre** pela instância resolvida, nunca do payload.

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
- **`services/providers/whapi/instanceAdmin.js`** — `getConnectionStatus` (`GET /health`); `configureWebhooks` real (`PATCH /settings` só `webhooks`, header `X-Webhook-Token`, URL `/webhooks/whapi` **sem** query token, `skipSendGuard`); `getLoginQr` ainda 501. Nunca no boot, nunca na instância UltraMSG.
- **`controllers/webhookWhapiController.js`** — `normalizeWhapiToInternal(message)` + `normalizeWhapiStatus(status)` + `handleWebhookWhapi` (itera `messages[]`/`statuses[]`, delega a `receberZapi`/`statusZapi`). Espelha `handleWebhookUltramsg`, **sem** importar o controller UltraMSG.
- **`middleware/resolveWhapiWebhookCompany.js`** — extrai `channel_id`, `getWhatsappInstanceByProviderInstanceId('whapi', channelId)`, injeta `req.webhookContext`/`req.zapiContext` com `provider:'whapi'`. (Cópia enxuta do resolver UltraMSG parametrizada — não reescrever o de UltraMSG.)
- **`routes/webhookWhapiRoutes.js`** — stack `webhookLogger('whapi') → webhookBodyResolver → requireWebhookToken → resolveWhapiWebhookCompany → handleWebhookWhapi`.
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
- Chat: `mediaMessageController`, `outboundController`, `retryController`, `forwardController` passam `getProvider({ provider })` (default ultramsg).
- Residual (não Fase B): `integrationController` (sync), `attendanceController` e `messageDeletionController` ainda chamam `getProvider()` sem provider → UltraMSG. Sync Whapi continua 501 via adapter se o caller passar `{ provider:'whapi' }`; até a Fase D o botão sincronizar de uma instância Whapi **não** deve ser usado.
- **Ainda stub 501:** `sendCall`, `deleteMessage`, sync Fase D (`getContacts`/…).
- **Homologação live (PENDENTE):** enviar/receber no número de teste **depois** de: (1) aplicar a migration; (2) criar instância `provider=whapi`; (3) deploy do código com `/webhooks/whapi`; (4) apontar webhook do canal (configure-webhooks ou painel) **sem** query token; (5) conversa com `whatsapp_instance_id` dessa instância. Rotacionar token depois.
- **Pronto de código quando:** testes Whapi + gate UltraMSG verdes. Live só com autorização.

### Fase C — painel conexão Whapi (health/QR pairing) + UI mínima cadastro — **parcial 2026-09-04**

**Feito (backend, sem PATCH live, sem UI):**
- `configureWebhooks` Whapi: `PATCH https://gate.whapi.cloud/settings` com `{ webhooks: [{ url: APP_URL/webhooks/whapi, mode: 'body', events: messages post/put/patch/delete + statuses post/put, headers: { X-Webhook-Token: WHATSAPP_WEBHOOK_TOKEN } }] }`. Recusa se o token de webhook estiver ausente. Não dispara send-guard.
- `POST /integrations/whatsapp/instances/:id/configure-webhooks` e o company-level `POST .../configure-webhooks` roteiam pelo provider da instância. Company-level: **UltraMSG primeiro**; Whapi só se a empresa não tiver default UltraMSG.
- `GET /instances/:id/status` em instância Whapi chama `GET /health` do adapter (não o QR/status UltraMSG).
- `GET/POST .../qrcode` e `POST .../restart` em instância Whapi → **501** (não empurram credencial Whapi no UltraMSG).
- HTTP Whapi ganhou `PATCH` (`skipSendGuard` em settings).

**Ainda falta (C restante):** UI `ConnectWhatsApp.jsx` (seletor UltraMSG | Whapi + Channel ID/Token); QR/pairing Whapi (`getLoginQr`).

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

### Fase D — sync contatos/grupos/histórico
- `getContacts/getChats/getGroups/getChatMessages/getProfilePicture/getContactMetadata` reais (endpoints Whapi próprios).
- **Até lá:** apertar "sincronizar" numa instância Whapi deve **501 claro**, nunca cair no serviço UltraMSG por engano.
- **Pronto quando:** sync não chama UltraMSG para instância whapi; retorna 501/no-op controlado antes de implementado.

### Fase E — disparo/campanha na instância Whapi
- Worker de disparo passa a `getProvider({ provider })` pela instância da campanha.
- **NÃO** nesta estrutura/MVP. `disparoSendService` e flags dry-run/live **não mudam** agora.
- **Pronto quando:** campanha numa instância whapi roteia whapi; produção UltraMSG inalterada.

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
| Disparo de produção | Fase E; worker não muda no MVP |

---

## 8. Como testar sem atingir cliente

- **Jest, fetch mockado, sem token real, sem número de cliente.** Casos mínimos: default getProvider=ultramsg; provider='whapi' roteia whapi; isolamento empresa A×B; webhook whapi inbound + ACK; `sendText` Bearer+JSON; instância ultramsg não passa pelo adapter whapi; stub 501 não finge sucesso.
- **Gate obrigatório:** rodar as suites UltraMSG/webhook atuais (doc 21 §10 e doc 24 §6) — verdes.
- **MCP `user-whapi-mcp`** só para **inspecionar contrato** (`checkHealth` `wakeup:false`, `getChannelSettings` GET, schemas). **Proibido** `sendMessage*`, `updateChannelSettings`, `webhookTest`, login/QR via MCP.
- **Homologação live:** só com autorização explícita, tenant/número de teste, allowlist e teto. `PATCH /settings` (webhook) só em homologação.

---

## 9. O que NÃO fazer (anti-padrões desta tarefa)

- ❌ Editar/refatorar qualquer arquivo da UltraMSG (`providers/ultramsg*`, `webhookUltramsgController`, `ultramsgIntegrationController`/`Service`, rotas ultramsg, alias `/webhooks/whatsapp`, `disparoSendService`).
- ❌ Apontar `/webhooks/whatsapp` para Whapi (é UltraMSG).
- ❌ Unificar adapter, JID, ou normalizador num "provider genérico".
- ❌ Inventar `referenceId` na Whapi; misturar id de fila numérico com wamid.
- ❌ MCP no runtime do adapter; send/settings via MCP.
- ❌ Fatiar/renomear/mover `receberZapi`/`statusZapi` (sem o mapa do doc 24).
- ❌ `company_id` de body/query; auth de webhook por `?token=`.
- ❌ Chamar UltraMSG por engano em sync de instância whapi (deve 501).
- ❌ Implementar Disparo (Fase E) ou paridade total agora.
- ❌ Aplicar migration, commitar, pushar, deploy, mexer em `.env` de produção, enviar mensagem real, QR/restart/settings em canal de cliente.

---

## 10. Achados do código (CONFIRMADO nesta sessão)

- `services/providers/index.js` (14 linhas): `getProvider()` devolve sempre ultramsg. **Único ponto** a tornar consciente de `opts.provider`.
- **Todos os `getProvider()` são sem-argumento** (chat/config/ia/jobs/whatsappIntegration/webhookInbound). Trocar para `{ provider }` é aditivo e local — cada caller **já tem `whatsappInstanceId`/instância em escopo** (ex. `outboundController` linha 59/70).
- `whatsappInstanceService.getWhatsappInstanceByProviderInstanceId(provider, id)` **já filtra `.eq('provider', p)`** e trata `DUPLICATE_PROVIDER_INSTANCE`. Um resolver whapi só chama com `'whapi'`.
- `resolveWebhookCompany.js` está **hardcoded `'ultramsg'`** (não agnóstico) → resolver whapi **novo** (não editar o de ultramsg).
- `requireWebhookToken`/`webhookBodyResolver`/`webhookLogger` são **agnósticos** → reusáveis na stack whapi.
- CHECK atual: `whatsapp_instances_provider_chk CHECK (provider IN ('ultramsg'))` em `supabase/migrations/20260615000000_whatsapp_instances_phase1.sql`. Unique `(company_id, provider, instance_id)` já existe. Migration Whapi **escrita, não aplicada**.
- `webhookUltramsgController.handleWebhookUltramsg` é o **template exato** a espelhar: normaliza envelope → `webhookCoreController.statusZapi`/`receberZapi`.
- **MCP 2026-09-04 (2ª leitura):** canal AUTH; webhook ainda em `/webhooks/ultramsg?token=`. `configureWebhooks` do adapter **não** foi chamado no canal.
- Painel: `whatsappIntegrationController` roteia status/QR/restart/configure-webhooks **por instância**. QR/restart Whapi = 501. Company-level configure-webhooks = UltraMSG primeiro.
