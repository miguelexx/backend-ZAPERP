# 21 — UltraMSG provider: mapa para modularização

> Criado: **2026-08-31** (plano). **Quebra executada no mesmo dia**, em duas sessões com gate de testes.  
> Fonte: `services/providers/ultramsg.js` (shim) + `services/providers/ultramsg/`.  
> Estados: **CONFIRMADO** = código/teste; **INFERÊNCIA**; **PENDENTE** = UltraMSG real / VPS.

Arquivo-alvo (fachada): [`services/providers/ultramsg.js`](../../services/providers/ultramsg.js) → `require('./ultramsg/index.js')`  
**Não** usar `require('./ultramsg')` *dentro* do shim: o Node resolveria o próprio `ultramsg.js` e ciclaria.  
Fachada de acesso: [`services/providers/index.js`](../../services/providers/index.js) (`getProvider()`).  
Webhook inbound **não** vive aqui — `webhookUltramsgController` → `webhookZapiController`.

---

## 0. Quebra executada (2026-08-31)

**Sessão 1:** `constants.js`, `result.js`, `phones.js` — funções puras; o monolito ainda importava. Suites: 57/57.  
**Sessão 2:** HTTP/config/delay/send/audio/upload/chats/contatos/foto/histórico/admin + shim. Suites: 57/57.

```
services/providers/ultramsg.js          ← shim (path e exports iguais)
services/providers/ultramsg/
  constants.js, result.js, phones.js
  delay.js, config.js, http.js
  send.js, audio.js, upload.js
  chatsAdmin.js, contacts.js, profilePicture.js
  chatMessages.js, instanceAdmin.js, index.js
```

`jest.mock('../services/providers/ultramsg')` e `getProvider()` continuam no path antigo. Sem migration, sem Socket.IO, sem env nova.

Como testar:

```text
NODE_ENV=test ZAPERP_DISABLE_BACKGROUND_JOBS=1 npx jest tests/ultramsgProviderInstanceResolution.test.js tests/whatsappIdentityFoto.test.js tests/oldMessagesAndSearch.test.js --runInBand
```

---

## 1. O que o adapter faz

Único adapter WhatsApp em produção. Credenciais por empresa/instância (`whatsapp_instances`; comentários ainda falam `empresa_zapi` — nome legado). Chamadas REST `https://api.ultramsg.com/instance{id}/…` com token no body/query (`application/x-www-form-urlencoded`, não JSON).

Responsabilidades misturadas no mesmo módulo:

1. Resolver instância (default vs `whatsappInstanceId`) com isolamento de tenant
2. HTTP (`post`/`get`), timeout, retry **só** de erro de conexão, logs com token mascarado
3. Normalizar telefone/JID (envio ≠ consulta)
4. Enviar texto/mídia/contato/localização/reação/voz
5. Upload CDN (`/media/upload`) com FormData nativo
6. Consultar chats, grupos, contatos, histórico (`/chats/messages`)
7. Foto de perfil (cache “sem foto”, rate limit, candidatos de JID)
8. Admin da instância (webhooks, status, nome/foto/descrição do perfil)
9. Delay in-memory entre envios por `companyId` + guarda `whatsappSendGuardService`

Recebimento/ACK **não** estão aqui.

---

## 2. Mapa por linhas (CONFIRMADO)

| Bloco | Linhas | Assunto | Candidato |
|-------|--------|---------|-----------|
| Constantes, Maps de delay, helpers de aceite/erro | 24–140 | `normalizeUltraMsgSendResult`, token inválido | `result.js` |
| URL, token, áudio MIME, log sanitizado | 142–399 | contrato HTTP + spam de foto | `http.js` + `audioFormats.js` |
| Delay, `resolveConfig`, `toUltramsgPhone`, `post`/`get` | 400–637 | tenant + form-urlencoded + send guard | `config.js` + `http.js` |
| Candidatos de chatId (histórico) | 639–717 | 12 e 13 dígitos BR | `phones.js` |
| `sendText` … `sendCall` | 722–1403 | envio | `send/*.js` |
| Contatos, chats, grupos | 1405–1630 | GET listas | `contacts.js` / `chats.js` |
| Foto/metadados (sem `toZapiSendFormat`) | 1632–1952 | cache + rate limit | `profilePicture.js` |
| `classifyChatMessagesPage` + `getChatMessages` | 1954–2120 | sync-old | `chatMessages.js` |
| `uploadMedia` | 2122–2298 | FormData nativo, retry seguro | `upload.js` |
| Webhooks / perfil / status | 2303–2374 | admin instância | `instanceAdmin.js` |
| `module.exports` | 2376–2431 | API pública | `index.js` + shim |

---

## 3. API pública a preservar

Callers usam `require('./providers/ultramsg')` **ou** `getProvider()`. Jest de Disparo faz `jest.mock('../services/providers/ultramsg')`. Qualquer split precisa de shim no path antigo com **os mesmos nomes**.

Exports **CONFIRMADOS**:

`sendText`, `sendLink`, `sendImage`, `sendFile`, `sendAudio`, `sendVoice`, `sendVideo`, `sendReaction`, `removeReaction`, `sendContact`, `sendLocation`, `sendCall`, `sendSticker`, `deleteMessage`, `resendByStatus`, `resendById`, `clearMessages`, `getMessagesStatistics`, `getMessages`, `archiveChat`, `unarchiveChat`, `readChat`, `clearChatMessages`, `deleteChat`, `getContacts`, `getChats`, `getGroups`, `getGroup`, `classifyChatMessagesPage`, `chatMessageCandidatesForLookup`, `profilePictureChatIdCandidates`, `contactRecordMatchesChatId`, `toLookupChatId`, `uploadMedia`, `getProfilePicture`, `invalidateNoProfilePictureCache`, `getContactMetadata`, `getChatMessages`, `configureWebhooks`, `updateProfilePicture`, `updateProfileName`, `updateProfileDescription`, `getConnectionStatus`, `normalizePhone`, `toUltramsgPhone`, `isConfigured` (sempre `true`), `buildBaseUrl`, `appendToken`, `get`, `post`, `maskTokenInLogs`, `normalizeChatId`, `validateRequiredFields`.

**Não exportados** (internos, mas críticos): `resolveConfig`, `normalizeUltraMsgSendResult`, `phoneCandidatesForSend`, `phoneToChatId`, `aplicarReferenceId`, `awaitSendDelay`.

Testes que importam o path direto:

- `tests/ultramsgProviderInstanceResolution.test.js` — instância, tenant, `referenceId`, upload, aceite HTTP 200
- `tests/whatsappIdentityFoto.test.js` — `profilePictureChatIdCandidates`, `toLookupChatId`
- `tests/oldMessagesAndSearch.test.js` — `classifyChatMessagesPage`, `chatMessageCandidatesForLookup`
- mocks: `disparoSendService.test.js`, `disparoReconciliacao.test.js`, `disparoOptOutService.test.js`

---

## 4. Invariantes (não regressar)

### 4.1 Tenant e instância

`resolveConfig` exige `companyId`. Com `whatsappInstanceId`, usa `getWhatsappInstanceById(cid, id, { includeCredentials: true, requireActive: true })` e **recusa instância de outra empresa** (teste cobre). Sem id, usa default da empresa. Sem instância/token → `null` e os sends falham com mensagem de “não configurada”.

Não ler `ULTRAMSG_INSTANCE_ID` / `ULTRAMSG_TOKEN` neste arquivo (isso é fallback de `whatsappConfigService`, outro caminho).

### 4.2 HTTP 200 ≠ sucesso

UltraMSG devolve HTTP 200 com `{ error: 'wrong token' }` ou `sent=false`. `normalizeUltraMsgSendResult` exige `messageId` **ou** `sent/success/ok/status` true-like. `sendAudio`/`sendVoice` rejeitam 200 sem aceite (testes).

Token inválido: `maybeInvalidateCacheOnBadToken` limpa cache de `whatsappConfigService`.

### 4.3 Retry cego duplica WhatsApp

`post` usa `fetchWithRetry(..., { retryConnectionErrors: true })` — retry **só** se a conexão nunca estabeleceu. Timeout/resposta ambígua **não** pode repetir o POST de mensagem.

`uploadMedia` **pode** retentar (sobe arquivo na CDN, não dispara mensagem). Recria FormData a cada tentativa. FormData **nativo** (WHATWG); o pacote npm `form-data` serializa `[object FormData]` e quebra o upload (teste cobre).

### 4.4 `referenceId`

`aplicarReferenceId` grava `crm-*` / `disp-*` no body. Sem isso o reconciliador não casa o eco `fromMe`. Endpoints de chat/image/document/audio/voice suportam o campo. Testes exigem presença no body.

### 4.5 Telefone: envio ≠ consulta

| Função | Usa `toZapiSendFormat` (insere 9)? | Uso |
|--------|-------------------------------------|-----|
| `phoneCandidatesForSend` / `toUltramsgPhone` / `phoneToChatId` | **sim** | enviar mensagem |
| `toLookupChatId` / `profilePictureChatIdCandidates` | **não** | foto / metadados |
| `chatMessageCandidatesForLookup` | tenta **os dois** (com 9 **e** JID cru 12 dígitos) | histórico `/chats/messages` |

Usar `phoneToChatId` em foto grava avatar no contato errado. Usar só o JID com 9 no sync-old devolve vazio falso. **Não unificar essas funções.**

Celular BR guardado sem o 9: `preferredBrSendDigits` vai **primeiro** em `phoneCandidatesForSend` (teste: insere o 9 no envio).

Grupo: `…@g.us`, `120…` longo, `NNNN-NNNN@g.us`.

### 4.6 Retornos mistos (preservar)

`sendText` sempre `{ ok, messageId, error, … }`.  
`sendImage` / vários de mídia: `false`/`true` **salvo** `opts.returnDetails === true`. Callers (chat, disparo) dependem disso. Não “padronizar” na quebra.

### 4.7 Send guard + delay

Todo `post` passa por `beforeWhatsAppSend` / `afterWhatsAppSend` com `whatsappInstanceId` resolvido (espaça por número, não só por empresa).  
`awaitSendDelay` é Map in-memory (`lastSendPerCompany`, teto 500 chaves). `ULTRAMSG_SEND_DELAY_MS` default 0. Processo único (PM2 fork 1).

### 4.8 Foto de perfil

Cache `noProfilePictureCache` TTL 1h; rate 2s por instância; `setInterval` 6h com `.unref()`. Consultar com `profilePictureChatIdCandidates`, nunca `phoneToChatId`.

### 4.9 Histórico

`GET /chats/messages` só vê o store da UltraMSG **desde a conexão**. Array vazio pode ser legítimo. HTTP 200 com `{error}` ≠ lista vazia (`classifyChatMessagesPage`).

### 4.10 Segredos

Token só mascarado em log (`maskToken`, `maskTokenInFormBody`). Nunca logar URL com token, body completo de mídia base64, nem `WHATSAPP_DEBUG` em produção sem teto.

---

## 5. Env lidas **neste** arquivo

| Variável | Papel |
|----------|--------|
| `ULTRAMSG_BASE_URL` | default `https://api.ultramsg.com` |
| `ULTRAMSG_SEND_DELAY_MS` | delay entre POSTs de envio (0 = off) |
| `ULTRAMSG_TIMEOUT_MS` | AbortSignal 30s default |
| `OLD_MESSAGES_SYNC_MAX_PAGES` | 1–20, default 10 |
| `OLD_MESSAGES_SYNC_DEBUG` / `WHATSAPP_DEBUG` | logs de histórico / verbose |
| `ULTRAMSG_SEND_DELAY` / `_MAX` | **só** `configureWebhooks` (delay no painel UltraMSG, 1–60 / 1–120) |
| `ULTRAMSG_WEBHOOK_DOWNLOAD_MEDIA` | default true; `false` desliga |
| `ULTRAMSG_WEBHOOK_RETRIES` | 1–5, default 3 |
| `WHATSAPP_WEBHOOK_TOKEN` | token configurado nos callbacks |

`ULTRAMSG_INSTANCE_ID` / `ULTRAMSG_TOKEN` **não** são lidos aqui.

---

## 6. Dependências internas

- `whatsappInstanceService` — credenciais
- `whatsappConfigService.invalidateEmpresaWhatsappConfigCache`
- `whatsappSendGuardService`
- `helpers/retryWithBackoff` (`fetchWithRetry`, `sleep`, `isConnectionLevelError`)
- `helpers/phoneHelper` (`normalizePhoneBR`, `toZapiSendFormat`, `preferredBrSendDigits`, `possiblePhonesBR`, `possiblePhonesForWhatsappIdentity`, `isSameWhatsappIdentity`, `extractPhoneFromChatId`)

Circularidade a evitar: `disparoSendService` já importa o provider; o provider **não** deve importar disparo/chatController.

---

## 7. Estrutura real (pós-quebra)

Shim **obrigatório** em `ultramsg.js` com path explícito `./ultramsg/index.js` (não `./ultramsg`).

```
services/providers/ultramsg.js              ← module.exports = require('./ultramsg/index.js')
services/providers/index.js                 ← inalterado (getProvider)
services/providers/ultramsg/
  constants.js
  result.js              normalizeUltraMsgSendResult, extract id, true/false-like
  phones.js              envio vs lookup vs foto vs histórico (quatro APIs, um arquivo)
  http.js                buildBaseUrl, appendToken, createFetchOptions, post, get, log, mask
  config.js              resolveConfig
  delay.js               awaitSendDelay + Map
  send.js                sendText/Link/Image/File/Video/Sticker/Contact/Location/Call/Reaction
  audio.js               sendAudio, sendVoice, tryMultipleAudioFormats
  upload.js              uploadMedia
  chatMessages.js        classifyChatMessagesPage, getChatMessages
  chatsAdmin.js          archive/read/delete/getChats/getGroups
  contacts.js            getContacts, getContactMetadata
  profilePicture.js      getProfilePicture, caches, rate limit
  instanceAdmin.js       configureWebhooks, getConnectionStatus, updateProfile*
  index.js               re-exporta a API atual
```

`getMessages*` ficou em `send.js` (API de mensagens enviadas, não histórico de chat). `phones.js` concentra a regra fácil de errar; não espalhar `toZapiSendFormat` nos sends.

---

## 8. Fases (concluídas em duas sessões)

Sessão 1 = fase 1. Sessão 2 = fases 2–6 no mesmo dia, só depois do gate de 57 testes.

Não “unificar” JID de envio e de foto. Não implementar retry de mensagem. Não apontar fetch a instância real.

---

## 9. Código morto / dívida (fora da quebra, salvo evidência)

| Item | Estado |
|------|--------|
| `sendLink` só chama `sendText` | CONFIRMADO — manter (preview de URL) |
| `isConfigured: true` constante | CONFIRMADO — callers podem checar; não remover na 1ª PR |
| Comentário `empresa_zapi` no header | legado; tabela de credenciais ativas é `whatsapp_instances` (**PENDENTE** se algum fallback ainda lê `empresa_zapi` via `whatsappConfigService`) |
| Retorno boolean vs objeto nos sends de mídia | dívida de API; preservar |
| `CONTACTS_API_CHUNK_MAX = 10000` | GET pesado; não mudar no split |
| Doc 06 path `ultramsgProvider.js` | errado; este doc 21 é a fonte para o adapter |

---

## 10. Como testar (sem UltraMSG real)

```text
NODE_ENV=test ZAPERP_DISABLE_BACKGROUND_JOBS=1 npx jest tests/ultramsgProviderInstanceResolution.test.js tests/whatsappIdentityFoto.test.js tests/oldMessagesAndSearch.test.js --runInBand
```

Nunca `ULTRAMSG_TOKEN` de produção, QR, restart, `configureWebhooks` contra instância real sem autorização explícita, allowlist e teto.

Manual (homologação): texto + `referenceId crm-*`; áudio; sync-old de contato com JID 12 dígitos; foto de celular vs fixo.

---

## 11. Checklist da implementação (feito)

- [x] `companyId` obrigatório em `resolveConfig`; instância de empresa B recusada
- [x] HTTP 200 com error body → `ok: false`
- [x] `post` de mensagem: retry só conexão; `uploadMedia` pode retentar
- [x] `referenceId` no body dos sends cobertos pelos testes
- [x] `phoneCandidatesForSend` ≠ `profilePictureChatIdCandidates` ≠ candidatos de histórico
- [x] FormData nativo no upload
- [x] `returnDetails` / boolean dos sends de mídia iguais
- [x] Token mascarado em log
- [x] Shim `services/providers/ultramsg.js` (`require('./ultramsg/index.js')`) e `getProvider()`
- [x] Suites da §10 verdes (57 testes)
