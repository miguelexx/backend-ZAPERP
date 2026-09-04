# 25 — Whapi Cloud: segunda integração WhatsApp (aditiva, UltraMSG intocável)

> Criado: **2026-09-03**. **ESTRUTURA / PLANO — nenhum código de runtime escrito ainda.**
> Fonte: código atual (providers/index, ultramsg shim, webhookUltramsgController, resolveWebhookCompany,
> whatsappInstanceService, outboundController) + docs 06/14/18/21/24.
> Estados: **CONFIRMADO** = li no código; **INFERÊNCIA**; **PENDENTE** = precisa do contrato real Whapi (MCP health/schema) antes de codar.

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
  send.js             ← sendText (real) + demais sends (stub 501 nas fases iniciais)
  chatMessages.js     ← getChatMessages (stub 501 até Fase D)
  contacts.js         ← getContacts/getContactMetadata (stub 501 até Fase D)
  profilePicture.js   ← getProfilePicture (stub 501 até Fase D)
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

- **Precisa migration?** Sim — 1 aditiva (CHECK aceitar `'whapi'`). **Escrita, NÃO aplicada.** Código novo depende dela: instância Whapi só é criável após aplicá-la (ordem: migration → deploy).
- **Precisa evento Socket novo?** **Não.** `nova_mensagem` / `status_mensagem` / `atualizar_conversa` bastam — o normalizador Whapi entrega o mesmo formato interno; o pipeline emite os mesmos eventos.
- **Risco de regressão UltraMSG:** meta **zero** com `provider=ultramsg`. Ver §7.
- **Risco de mensagem duplicada:** nunca cadastrar o **mesmo número** nas duas APIs simultaneamente (ambas entregariam webhook). Documentado; sem trava automática de banco (números diferentes por design).

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
| `sendImage/sendFile/sendVideo/sendSticker` | `false`/`true`, **ou** objeto se `opts.returnDetails===true` | **B** |
| `sendAudio/sendVoice` | idem; 200 sem aceite = falha | B |
| `sendReaction/removeReaction` | boolean | B |
| `sendContact/sendLocation` | boolean/objeto | B |
| `sendCall` | só se o produto usar (INFERÊNCIA: não usado no chat) | stub |

`opts` sempre carrega `{ companyId, whatsappInstanceId, referenceId?, returnDetails? }`.
**HTTP 401/403 / `sent=false` NÃO é sucesso** → `normalizeWhapiSendResult` exige id de mensagem ou flag de sucesso.

### 2.2 Chat admin / consultas / instância (mapa completo, stub até a fase)

| Grupo | Métodos | Whapi Fase |
|---|---|---|
| Chat admin | `deleteMessage, archiveChat, unarchiveChat, readChat, clearChatMessages, deleteChat` | B/D (stub antes) |
| Consultas | `getContacts, getChats, getGroups, getGroup, getChatMessages, getProfilePicture, getContactMetadata, uploadMedia` | D (stub antes) |
| Instância | `getConnectionStatus, configureWebhooks` + **health** + **QR/pairing** (equivalente Whapi de sessão WhatsApp Web) | A(health/status) / C(QR) |

### 2.3 Regras de erro / rede (iguais em espírito ao UltraMSG)

- Retry de POST de mensagem **só** em erro de conexão (nunca timeout/resposta ambígua) — reusar `helpers/retryWithBackoff` (`fetchWithRetry`, `isConnectionLevelError`).
- Reusar `whatsappSendGuardService` (`beforeWhatsAppSend`/`afterWhatsAppSend`) por `whatsappInstanceId` — espaça por número.
- `uploadMedia` **pode** retentar (não dispara mensagem).
- **Segredos:** token Whapi só em `instance_token`; **nunca** logar token/Bearer/URL-com-token/mídia base64. `maskTokenInLogs` próprio.

### 2.4 Telefone / JID Whapi (NÃO reusar as 4 APIs de JID da UltraMSG)

- **Proibido** chamar `toUltramsgPhone` / `phoneToChatId` / `profilePictureChatIdCandidates` / `chatMessageCandidatesForLookup`.
- Whapi: `to` = número internacional **sem `+`** (ex. `5534999999999`), grupos `...@g.us`, contatos podem chegar `...@s.whatsapp.net`.
- Normalização BR: usar `helpers/phoneHelper` (`normalizePhoneBR`, `preferredBrSendDigits`, `possiblePhonesForWhatsappIdentity`) — mesma base que a identidade WhatsApp já usa, sem a mangueira de JID UltraMSG.
- **PENDENTE:** confirmar via MCP se Whapi aceita número puro ou exige sufixo `@s.whatsapp.net` no `to` de `/messages/text`.

---

## 3. Mapa de webhooks Whapi → formato interno

Whapi envia **arrays** por evento: `messages` (inbound e `from_me`) e `statuses` (ACK). O normalizador itera cada item e chama o handler certo,
espelhando o padrão de lote (`getPayloads`) que o pipeline já entende.

```
POST /webhooks/whapi { messages:[...], statuses:[...], channel_id, event? }
  → resolveWhapiWebhookCompany: channel_id → company_id (provider='whapi')
  → para cada m em messages:   normalizeWhapiToInternal(m)  → req.body = {..., type:'ReceivedCallback'}   → receberZapi
  → para cada s em statuses:   normalizeWhapiStatus(s)       → req.body = {..., type:'MessageStatusCallback'} → statusZapi
```

O objeto interno tem de reproduzir as chaves que `normalizeUltramsgToZapi` produz (ver `webhookUltramsgController.js`). Mapa por evento:

| Interno (zapi-like) | UltraMSG origem | Whapi origem (INFERÊNCIA — confirmar MCP) |
|---|---|---|
| `instanceId` / `instance_id` | `body.instanceId` (numérico) | `channel_id` (ex. `NEBULA-AER3B`) |
| `messageId` / `id` / `zaapId` | `data.id` (`false_...@c.us_SID`) | `message.id` (wamid estilo WhatsApp) |
| `fromMe` | `data.fromMe` | `message.from_me` |
| `phone` / `remoteJid` | JID de `from`/`to` | `message.chat_id` (privado) / grupo `...@g.us` |
| `participantPhone` | `data.author` | `message.from` em grupo |
| `type` | `data.type` (`ptt`→`audio`) | `message.type` (`text/image/audio/voice/video/document/sticker/location/contact/reaction`) |
| `body`/`message`/`text.message` | `data.body` | `message.text.body` (ou `caption`) |
| `imageUrl/audioUrl/videoUrl/documentUrl/stickerUrl` | `data.media`/derivados | `message.<type>.link` (URL) — mídia **inbound via link** (Fase B) |
| `senderName` (só `!fromMe`) | `data.pushname` | `message.from_name` |
| `quotedMsg` / `referenceMessageId` | `data.quotedMsg` | `message.context.quoted_id` / `quoted_content` |
| reação | `event=reaction`+quotedMsg | `message.type='reaction'` (`emoji` + `target message id`) |
| `timestamp` | `data.time*1000` | `message.timestamp*1000` |
| ACK `status` | `data.ack` (`sent/device/read/played`) | `status.status` (`sent/delivered/read/played`) via `statuses[]` |

Invariantes preservados (todos já garantidos pelo núcleo — o normalizador **não pode violá-los**):

1. **Chatbot NÃO dispara** em reação / Status/broadcast / grupo / `fromMe` / ACK. Origem = JID do chat, não `participant` (guarda `chatbotInboundGuard.js`).
2. **`fromMe`** (eco do que o CRM/celular enviou): nome/foto do payload são **nossos**, unread inicial 0, não emite `atualizar_conversa` na reconciliação.
3. **ACK sem regressão** (`pending→sent→delivered→read`), grupo capa `read/played` em `delivered` (`messageStatusHelper`).
4. **Idempotência** por `(company_id, whatsapp_instance_id, whatsapp_id)` — o `whatsapp_id` interno = id da mensagem Whapi.
5. **Mídia inbound** só por `inboundMediaPersistenceService` (HTTPS, SSRF, R2/local) — Fase B; antes disso, placeholder tipado como hoje.
6. **HTTP:** inbound com erro interno persistente → 500 (retry provider); instância não mapeada / duplicada / ACK → 200 (igual ao UltraMSG).

**Auth webhook:** reusar `requireWebhookToken` (timing-safe, `WHATSAPP_WEBHOOK_TOKEN`) via **header** `X-Webhook-Token` ou `Authorization: Bearer` — **nunca `?token=` na query** (vuln de log já conhecida). Se a Whapi mandar header próprio de assinatura, validar adicionalmente. Tenant **sempre** pela instância resolvida, nunca do payload.

---

## 4. Estratégia de IDs / reconciliação / lacuna do `referenceId`

Problema: UltraMSG casa o eco `fromMe` do outbound via `referenceId` (`crm-<mensagemId>` / `disp-<filaId>`) gravado no body do send.
**Whapi não documenta campo `referenceId` no `/messages/text`.** Não inventar um.

Solução do dia-1 (mais simples e robusta que a do UltraMSG):

1. **`POST /messages/text` da Whapi retorna o id da mensagem na resposta síncrona** (INFERÊNCIA forte — confirmar MCP: campo `message.id` ou `sent`+`id`).
2. `sendText` captura esse id e o devolve em `{ ok, messageId }`. O chat **já grava `messageId` como `whatsapp_id`** na linha outbound (mesmo caminho do UltraMSG).
3. Quando o eco `fromMe` chega pelo webhook, ele traz **o mesmo id**. A reconciliação acontece por **`whatsapp_id` + idempotência** (o núcleo já deduplica por `whatsapp_id`) — **sem** depender de `referenceId`.

O que **NÃO** funciona no dia-1 (declarar explícito, vira fase posterior):

- O caminho `tryReconcileFromMeByCrmReferenceId` (janela 15min por `crm-*`) **não** dispara para Whapi. Substituto = match por `whatsapp_id` capturado no envio. Se a Whapi **não** devolver id síncrono, cair no fallback já existente (candidato por texto/mídia + janela) — a projetar em Fase B se confirmado.
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
- **`services/providers/whapi/instanceAdmin.js`** — `getConnectionStatus`/`health` (`GET /health`), QR/pairing (Fase C), `configureWebhooks` (`PATCH /settings` — **só homologação**, nunca no boot de produção, nunca na instância UltraMSG).
- **`controllers/webhookWhapiController.js`** — `normalizeWhapiToInternal(message)` + `normalizeWhapiStatus(status)` + `handleWebhookWhapi` (itera `messages[]`/`statuses[]`, delega a `receberZapi`/`statusZapi`). Espelha `handleWebhookUltramsg`, **sem** importar o controller UltraMSG.
- **`middleware/resolveWhapiWebhookCompany.js`** — extrai `channel_id`, `getWhatsappInstanceByProviderInstanceId('whapi', channelId)`, injeta `req.webhookContext`/`req.zapiContext` com `provider:'whapi'`. (Cópia enxuta do resolver UltraMSG parametrizada — não reescrever o de UltraMSG.)
- **`routes/webhookWhapiRoutes.js`** — stack `webhookLogger('whapi') → webhookBodyResolver → requireWebhookToken → resolveWhapiWebhookCompany → handleWebhookWhapi`.
- **migration** — `ALTER TABLE public.whatsapp_instances DROP CONSTRAINT whatsapp_instances_provider_chk; ADD CONSTRAINT whatsapp_instances_provider_chk CHECK (provider IN ('ultramsg','whapi'));` **NÃO aplicar.**

---

## 6. Fases de implementação (ordem + critério de pronto)

### Fase A — banco + roteamento + adapter (health/sendText) + webhook texto/ACK
- Migration escrita (CHECK aceita `whapi`), **não aplicada**.
- `getProvider(opts)` roteando; no-arg/default ultramsg. `normalizeProvider` allowlist `ultramsg|whapi`.
- `whapi/`: `http`, `config`, `phones`, `result`, `send.sendText` real, `instanceAdmin.getConnectionStatus/health`. Restante stub 501.
- `webhookWhapiController` (texto + ACK) + `resolveWhapiWebhookCompany` + rota `/webhooks/whapi` + montagem em `app.js`.
- Chat controllers: **só texto** passa `getProvider({ provider })`.
- **Pronto quando:** suites UltraMSG **todas verdes**; testes novos verdes (default=ultramsg; instância whapi roteia whapi; empresa A não pega instância B; webhook whapi inbound texto + ACK sem regressão; sendText Bearer+JSON; instância ultramsg **não** passa pelo adapter whapi). Migration revisada. Nenhuma chamada real a canal.

### Fase B — mídia inbound/outbound
- `send.sendImage/File/Audio/Voice/Video/Sticker/Reaction/Location/Contact` reais; `uploadMedia`.
- Normalizador: mídia inbound via `link` → `inboundMediaPersistenceService` (HTTPS/SSRF/R2).
- **Pronto quando:** enviar/receber imagem, áudio, documento em número de teste; placeholder tipado no gap; sem regressão de reconciliação.

### Fase C — painel conexão Whapi (health/QR pairing) + UI mínima cadastro
- Backend: endpoints NOVOS ou ramos por `provider` para health/QR/pairing — **sem** reescrever `ultramsgIntegrationService`.
- Frontend: ao criar instância, escolher Provider (UltraMSG default | Whapi); se Whapi → Channel ID + Token (+ QR depois). Não tocar QR UltraMSG nem chat.
- **Pronto quando:** criar instância Whapi pela UI, ver health/QR, sem quebrar fluxo UltraMSG.

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
- **MCP `user-whapi-mcp`** só para **inspecionar contrato** (health/schema) — `wakeup:false` se tocar o canal. **Proibido** send/settings/login/QR via MCP nesta tarefa.
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
- CHECK atual: `whatsapp_instances_provider_chk CHECK (provider IN ('ultramsg'))` em `supabase/migrations/20260615000000_whatsapp_instances_phase1.sql`. Unique `(company_id, provider, instance_id)` já existe.
- `webhookUltramsgController.handleWebhookUltramsg` é o **template exato** a espelhar: normaliza envelope → `webhookCoreController.statusZapi`/`receberZapi`.
