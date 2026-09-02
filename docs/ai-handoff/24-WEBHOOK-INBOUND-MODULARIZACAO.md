# 24 — Webhook inbound/ACK: mapa para modularização

> Criado: **2026-09-01**. Fonte: código atual.  
> **Fases 1–4 feitas** (`controllers/webhookInbound/` — payload, reopen, lookup, fromMe, statusZapi, log, disparoInbound). **Fase 5 em andamento:** saídas antecipadas extraídas (`instanceResolve`, `groupPhoto`); o **miolo** de `receberZapi` ainda no arquivo (com caracterização em `tests/receberZapiInbound.test.js`). Não mover `receberZapi`/`statusZapi` sem este mapa.  
> Estados: **CONFIRMADO** = código/teste; **INFERÊNCIA**; **PENDENTE** = UltraMSG real / VPS.

Arquivo-alvo: [`controllers/webhookZapiController.js`](../../controllers/webhookZapiController.js) (~3.0k linhas após fases 1–4; miolo de `receberZapi` ainda aqui).  
Nome **legado**. Handler **ativo** de inbound e ACK do UltraMSG. Não existe rota pública Z-API.

Camada UltraMSG (já separada): [`controllers/webhookUltramsgController.js`](../../controllers/webhookUltramsgController.js) (~369 linhas) normaliza o envelope e **delega**.  
Rotas: [`routes/webhookUltramsgRoutes.js`](../../routes/webhookUltramsgRoutes.js) → `POST /webhooks/ultramsg` e alias `/webhooks/whatsapp`.  
Stack: `webhookLimiter` → `webhookLogger` → `webhookBodyResolver` → `requireWebhookToken` → `resolveWebhookCompany` → `handleWebhookUltramsg`.

Ponta a ponta (chat → provider → webhook): [06](06-WHATSAPP-ULTRAMSG-E-WEBHOOKS.md). Adapter de **envio**: [21](21-ULTRAMSG-PROVIDER-MODULARIZACAO.md). Chat HTTP: [23](23-CHAT-CONTROLLER-MODULARIZACAO.md). Chatbot: não fundir com este split.

**Não executar a quebra neste documento.** Sem mapa, fatiar `receberZapi` duplica mensagem, quebra `fromMe`/ACK/grupo.

Preservar working tree do chat (`conversationListController` / `textMessageController` / `pixController` untracked) se ainda existirem.

---

## 1. O que o pipeline faz

```
UltraMSG POST
  → token + instanceId → company_id (JWT não entra aqui)
  → webhookUltramsgController.normalizeUltramsgToZapi
  → event_type message_ack*     → webhookZapiController.statusZapi
  → event_type message_received* → webhookZapiController.receberZapi
```

`receberZapi` (um payload por vez, lote via `getPayloads`):

1. Resolve tenant pela instância (`req.zapiContext` ou `whatsapp_instances` / fallback `empresa_zapi`).
2. Classifica o envelope (foto de grupo, ACK embutido, DeliveryCallback, self-echo `fromMe`).
3. Extrai mensagem (`extractMessage`) e chave de conversa (`resolveConversationKeyFromZapi`).
4. Localiza/cria cliente + conversa (`conversationSync`) com `whatsapp_instance_id`.
5. **Antes do insert:** guarda `inboundReentregue` (mesmo `whatsapp_id`) — sem isso, replay dispara URA/reabertura.
6. Efeitos em conversa fechada, modo simples, **chatbot** (`processIncomingMessage`), **primeira resposta de campanha**.
7. Persistência: insert inbound; `fromMe` tenta **reconciliar** outbound do CRM (`referenceId crm-*`, texto/mídia, janela 15 min) antes de inserir eco.
8. Agenda mídia (`inboundMediaPersistenceService`), hooks de **Disparo** (opt-out / resposta / origem `fromMe`), CRM externo (`setImmediate`).
9. Socket (`nova_mensagem`, `atualizar_conversa` só se `!fromMe`), unread, push.

`statusZapi`: localiza mensagem por `whatsapp_id` (e fallbacks de fila/`provider_queue_id`), aplica ACK **sem regressão**, emite `status_mensagem`, espelha R2, chama `disparoWebhookHook.aplicarStatusDisparoFromWebhook`.

---

## 2. Camadas — o que NÃO misturar

| Camada | Onde vive | Papel | Não fazer no split |
|--------|-----------|--------|-------------------|
| Envelope UltraMSG | `webhookUltramsgController` | `event_type`, `data.id`/`sid`, JID, mídia URL, `fromMe`, grupo `@g.us` | Não jogar `normalizeUltramsgToZapi` para dentro de `receberZapi` “para unificar”. Já é outro arquivo. |
| Auth/tenant HTTP | `requireWebhookToken`, `resolveWebhookCompany` | Token timing-safe; `company_id` da instância | Não ler tenant do body. |
| Payload legado | `extractMessage`, `getPayloads`, `isGroupPayload`, `resolveConversationKeyFromZapi` | Formato interno “zapi-like” | Não “simplificar” fontes de telefone/`fromMe`. |
| Identidade | `helpers/conversationSync.js` | Cliente/conversa/LID/instância | **Não fatiar** `conversationSync` neste trabalho (doc próprio depois). |
| Persistência mensagem | insert/select em `receberZapi` | `whatsapp_id` + `company_id` + instância | Não relaxar unique / não insert cego de `fromMe`. |
| Mídia inbound | `inboundMediaPersistenceService` | HTTPS, SSRF, disco/R2 | Não mudar política de download no split. |
| ACK | `statusZapi` + `messageStatusHelper` | rank; grupos `read`→`delivered` | Não regredir status. |
| Realtime | `chatController` reexports (`emitirParaUsuariosQuePodemVerConversa`, unread) | Salas tenant | Não instalar listener no webhook. `io` via `req.app.get('io')`. |
| Chatbot | `chatbotTriageService.processIncomingMessage` | URA; anti-replay de idade + `inboundReentregue` | Não mover a URA para esta pasta. |
| Disparo | `disparoWebhookHook`, `consumirPrimeiraRespostaCampanha`, opt-out | Fila/`disp-*`/wamid | Não unificar `crm-*` com `disp-*`. |

---

## 3. Mapa por linhas (⚠️ OBSOLETO após a Fase 5 — usar só como referência conceitual)

> **Os números de linha abaixo NÃO valem mais** (6 blocos extraídos na Fase 5 encolheram o arquivo de
> ~4.216 → 2.860 linhas). A **sequência conceitual** dos blocos continua correta; para localizar algo,
> use `grep` pelos marcos (ex. `exports.receberZapi`, `inboundReentregue`, `processIncomingMessage`,
> `incrementarUnread`, `// 4) Realtime`). Estrutura real dos módulos já extraídos: §7.

| Bloco | Linhas | Assunto | I/O | Candidato |
|-------|--------|---------|-----|-----------|
| Header + requires | 1–90 | Inclui `chatController` (unread/emit), chatbot, mídia, `conversationSync` | — | shim |
| `whatsapp_id` + filtro de instância | 92–247 | `selectSingleMensagemByWhatsappId`, legado `instance_id` nulo, ambiguidade | DB | `whatsappIdLookup.js` |
| Mídia + fromMe reconcile helpers | 249–485 | família image/sticker, `findPendingOutboundByAckPhone`, `tryReconcileFromMeByCrmReferenceId`, candidato por arquivo | DB | `fromMeReconcile.js` + `mediaMatch.js` |
| Reabrir conversa | 487–564 | `shouldReopenFinishedConversation` | puro | `reopenPolicy.js` |
| Log | 566–592 | cert + buffer debug | — | `log.js` |
| Grupo / chave / extract | 594–1147 | `isGroupPayload`, `pickGroupChatId`, `resolveConversationKeyFromZapi`, `extractMessage` | puro | `payload.js` |
| Envelope lote + instância no body | 1149–1208 | `getPayloads`, `hasDestFields` | puro | `payload.js` |
| Disparo: 1ª msg WhatsApp externo | 1210–1252 | | DB | deixar no orquestrador ou `disparoInbound.js` |
| **`exports.receberZapi`** | **1254–4216** | orquestrador (~2.960 linhas) | HTTP+DB+provider+socket | `receberZapi.js` **por último** |
| resolve tenant + ignore | 1254–1294 | duplicate instance / not mapped → **200** | DB | `instanceResolve.js` |
| foto de grupo só | ~1321–1381 | | DB | handler pequeno |
| loop `payloads` + ACK embutido no received | 1400–1590 | `updateStatusByWaId` sem regressão | DB+socket | pode reusar `statusApply.js` |
| DeliveryCallback / self-echo `fromMe` | 1592–1970 | | DB | orquestrador |
| extract + newsletter | 1972–2005 | | puro | já em `payload.js` |
| sync contato, findOrCreate conversa | ~2062–2408 | unread inicial `fromMe?0:1` | DB+UltraMSG GET | orquestrador; usa `conversationSync` |
| **`inboundReentregue`** | **2410–2436** | replay → não URA/reabrir | DB | **invariante** |
| reabertura / avaliação | 2438–2648 | | DB | orquestrador |
| chatbot + skip campanha | 2650–2887 | `processIncomingMessage`; `sendOrigin: chatbot_triage` | DB+send | **não** extrair a URA |
| `consumirPrimeiraRespostaCampanha` | 2890–2901 | | DB | disparo |
| persistência + placeholder `(mídia)` | 2903–3164 | insert `!fromMe`; `fromMe` também pode inserir após falha de reconcile | DB | `persistMensagem.js` |
| reconcile `fromMe` | 3166–3310 | `crm-*` depois janela 15 min | DB | `fromMeReconcile.js` |
| insert + `23505` + mídia `setImmediate` | 3310–3650 | | DB | persistência |
| disparo origem/`opt-out` | 3657–3776 | | DB | disparo |
| sockets / unread / `atualizar_conversa` só `!fromMe` | 3930–4155 | | socket | realtime (já em `services/chat/realtime`) |
| HTTP `receberZapi` | 4212 **200** / 4215 **500** | inbound falhou → retry provider | — | **invariante** |
| **`exports.statusZapi`** | **4224–4579** | ACK dedicado | DB+socket | `statusZapi.js` |
| HTTP ACK | 4575/4578 **sempre 200** | catch inclusive | — | **invariante** |
| `exports._test` | 4582–4598 | contrato Jest | — | reexportar iguais |

`handleWebhookUltramsg` catch próprio devolve **200** se o normalizador **lança** antes de delegar. Se `receberZapi` já enviou **500**, essa é a resposta. Não “unificar” os dois códigos HTTP.

---

## 4. Invariantes (não “consertar” no split)

1. **`company_id` da instância** (`req.zapiContext` / `whatsapp_instances`). Payload **não** escolhe tenant. Instância duplicada no provider → 200 `duplicate_provider_instance`.
2. **Idempotência de linha:** unique `(company_id, whatsapp_instance_id, whatsapp_id)` (+ variante legada sem instância). Tratar `23505`. Linhas com `whatsapp_instance_id` nulo continuam no lookup (`applyWhatsappInstanceFilterOrLegacy`).
3. **Idempotência de efeitos:** `inboundReentregue` **antes** de chatbot/reabertura. Segunda defesa: idade do inbound na URA (`chatbotTriageAntiReplay.test.js`) — não remover uma achando que a outra basta.
4. **`fromMe`:** eco do celular/CRM. Reconciliar `referenceId` `crm-*` **antes** de inserir duplicata. Nome/foto do payload em `fromMe` é **nosso**, não do contato. Unread inicial 0. **Não** emitir `atualizar_conversa` na reconciliação (comentário no código: bug visual). Frontend **não** notifica `fromMe`.
5. **Grupo:** JID `@g.us` completo (hífen UltraMSG). `read`/`played` no ACK de grupo capam em `delivered` ([06](06-WHATSAPP-ULTRAMSG-E-WEBHOOKS.md)).
6. **ACK não regride** (`statusRank` / `messageStatusHelper`). `read` no contato **não** zera unread do CRM.
7. **HTTP:** inbound processado com erro interno → **500** (retry). ACK / instância não mapeada / duplicate → **200**.
8. **`referenceId`:** chat `crm-<mensagem_id>`; disparo `disp-<item>`. ACK UltraMSG quase nunca ecoa `referenceId`; wamid ≠ id numérico de fila (`provider_queue_id`).
9. **Lote:** `getPayloads` — `continue`/`skip` é por item, não `return` da request (placeholder mídia).
10. **Não unificar** as quatro APIs de JID do adapter ([21](21-ULTRAMSG-PROVIDER-MODULARIZACAO.md)).
11. **Não renomear** `webhookZapiController.js` / `receberZapi` / `statusZapi` nesta quebra. Shim no path antigo.
12. **Ciclo:** este arquivo `require` a fachada do chat. Submódulo **não** deve `require` a fachada do webhook de volta. Preferir `services/chat/realtime` / unread direto, como o chat já faz, se um helper precisar emitir — sem inverter dependência num PR “só split”.

---

## 5. Dívida (fora da quebra)

| Item | Estado |
|------|--------|
| Comentários “Z-API” / `logZapiCert` | legado; não reintroduzir provider |
| Comentários `@see` ADR | apontam para `docs/reference/ADR-LEGACY-NAMING.md` |
| `handleWebhookUltramsg` catch → 200 vs `receberZapi` catch → 500 | assimetria **CONFIRMADA**; não unificar no split |
| Fallback `statusZapi` `company_id` via `whatsapp_id` sem instância | ambíguo se >1 linha; já loga e pode ignorar |
| Sem teste e2e de `receberZapi` HTTP | **PARCIAL** — `tests/receberZapiContract.test.js` (2026-09-01, **6 testes**) cobre: **contrato HTTP §4.7** (not-mapped/duplicate/foto-grupo → 200; erro interno persistente → 500) + **anti-replay §4.3** (replay via `inboundReentregue` → chatbot/URA NÃO acionado). **Como forçar o replay no teste:** mockar `webhookInbound/whatsappIdLookup.selectSingleMensagemByWhatsappId` condicionalmente (só `context:'received.preprocess.idempotency'` retorna linha) — o mock global de supabase sozinho retorna null aí. **Achado:** erro de 1 item é absorvido (200); só estrutural/persistente → 500. **COMPLEMENTADO** por `tests/receberZapiInbound.test.js` (2026-09-01, **2 testes**, via SPIES pois o mock global de supabase é chain singleton): **(A)** inbound novo (texto,!fromMe,não-replay) → `incrementarUnreadParaConversa(company_id,conv)` + emite `nova_mensagem` **e** `atualizar_conversa`; **(B)** eco `fromMe` reconciliado por `crm-*` (mock de `fromMeReconcile.tryReconcileFromMeByCrmReferenceId`) → **sem** unread e **sem** `nova_mensagem`. Truque p/ isolar o insert: conversa com `departamento_id!=null` (pula o chatbot) e idempotência mockada → null (não-replay). |
| `receberZapi` define `normalizeZapiStatus` / `emitStatusMsg` **dentro do loop** | extração verbatim; não “otimizar” hoist no 1º PR |
| **REGRESSÃO da fase 1-4 (commit c9cf02d) — CORRIGIDA 2026-09-01** | Ao extrair `fromMeReconcile.js`, o import `const { extrairNomePrefixoTexto } = require('../helpers/mensagemAtendenteNomeHelper')` **saiu do controller**, mas 2 usos ficaram no `receberZapi` (caminho **fromMe self-echo**, ~1758/2010) → `ReferenceError: extrairNomePrefixoTexto is not defined` → **500 em todo eco fromMe** (UltraMSG reentregaria em loop). Estava presente no HEAD~5, sumiu no HEAD. Import **restaurado** (fix mínimo, restaura comportamento pré-modularização). Pego pelo `receberZapiInbound.test.js` (B). **Lição p/ a Fase 5:** ao mover um bloco, rodar o diff `imports(HEAD_pré) − imports(atual)` e conferir se cada nome removido ainda é referenciado no corpo — não confiar só no `node --check` (ReferenceError de função não-declarada só estoura em runtime). |

---

## 6. Testes existentes (gate)

Não há `*Ack*.test.js` com esse nome. Suites relevantes:

| Suite | O que cobre |
|-------|-------------|
| `webhookZapiPure.test.js` | `_test`: grupo, `getPayloads`, `resolveConversationKeyFromZapi`, `extractMessage` |
| `webhookReconcileReferenceId.test.js` | `tryReconcileFromMeByCrmReferenceId` |
| `webhookLogService.test.js` | sanitizar log (não o controller) |
| `messageStatusHelper.test.js` | rank ACK / não regressão |
| `disparoWebhookHook.test.js` | ACK → fila disparo |
| `disparoUltramsgReferenceId.test.js` | `disp-*` / wamid / `provider_queue_id` |
| `whatsappOperationalPhase2.test.js` + `_1` | conversa/instância no caminho operacional (mocks) |
| `inboundMediaPersistence.test.js` / `inboundAudioFormat.test.js` | download inbound |
| `chatbotTriageAntiReplay.test.js` | idade do inbound na URA (**não** a guarda `inboundReentregue` do controller) |
| `clientTempIdAndLegacyWebhook.test.js` | sobretudo **chat outbound** `_test`; o nome engana |
| `productionAuthorization.test.js` | `GET /webhooks/ultramsg` sem auth de negócio |
| `pendingOutboundReconciliation.test.js` | fila pendente pós-ACK |

Gate mínimo **antes** de qualquer extração:

```text
NODE_ENV=test ZAPERP_DISABLE_BACKGROUND_JOBS=1 npx jest tests/webhookZapiPure.test.js tests/webhookReconcileReferenceId.test.js tests/messageStatusHelper.test.js tests/disparoWebhookHook.test.js tests/chatbotTriageAntiReplay.test.js tests/whatsappOperationalPhase2.test.js tests/whatsappOperationalPhase2_1.test.js --runInBand
```

Não apontar fetch a instância UltraMSG real. Não `WHATSAPP_WEBHOOK_TOKEN` de produção nos testes.

---

## 7. Estrutura REAL (2026-09-01) — `controllers/webhookInbound/` (12 módulos)

`controllers/webhookZapiController.js` continua sendo a fachada: mantém `receberZapi` (miolo) inline e
reexporta `statusZapi` + `_test`. Módulos já extraídos (todos verbatim, gate verde):

| Módulo | Papel | Fase |
|--------|-------|------|
| `payload.js` | puros: tipo, grupo, `extractMessage`, `getPayloads`, `resolveConversationKeyFromZapi` | 1 |
| `reopenPolicy.js` | `shouldReopenFinishedConversation` (puro) | 1 |
| `whatsappIdLookup.js` | select/update/patch por `whatsapp_id` + filtro de instância (DB) | 2 |
| `fromMeReconcile.js` | reconciliação `fromMe` + mediaMatch (DB) | 2 |
| `statusZapi.js` | handler de ACK completo (reexportado pela fachada) | 3 |
| `log.js` | `logZapiCert` / `_logWebhook` / `_logWebhookSafe` (buffer debug) | 4 |
| `disparoInbound.js` | origem disparo + `scheduleInboundDisparoHooks` (Etapa 8, fire-and-forget) | 4/5 |
| `instanceResolve.js` | resolução de tenant (empresa/instância) — saída antecipada | 5 |
| `groupPhoto.js` | callback `{groupId,groupPhoto}` — saída antecipada | 5 |
| `historyImport.js` | import de histórico ao abrir conversa nova (fire-and-forget) | 5 |
| `crmLeadInbound.js` | captura de lead CRM (fire-and-forget) | 5 |
| `groupSender.js` | resolve remetente/membro em grupos (contrato→saída; `tests/webhookGroupSender.test.js`) | 5 |
| `realtimePayload.js` | **puro**: monta os payloads `conversa_atualizada` e `nova_mensagem` do emit-tail (`tests/webhookRealtimePayload.test.js`, 11 testes) | 5 |
| `persistMensagem.js` | **puro**: `applyInboundMediaFields` mapeia `type/mídia → campos do insert` (`tests/webhookPersistMensagem.test.js`, 8 testes). Insert+retries+23505 ainda no orquestrador | 5 |
| `statusApply.js` | **puro**: `resolveEffectiveStatus` — ACK sem regressão (invariante §4; `tests/webhookStatusApply.test.js`, 6 testes) | 5 |

**Ainda inline no `receberZapi` (núcleo acoplado, sem módulo):** montagem do insert + persistência
(`persistMensagem` planejado), reconcile `fromMe` no fluxo received, reabertura/avaliação, chatbot, e o
**realtime/emit tail**. `statusApply` compartilhado (ACK embutido no received) segue dentro do loop.
`webhookUltramsgController.js` **não** entra nesta pasta. Um `index.js` agregador só se/quando a fachada virar shim fino.

---

## 8. Fases

Cada fase: **sem** mudar rota, evento Socket, migration, env. Verbatim. Suites da §6 verdes.

| Fase | O quê | Risco | Gate | Estado |
|------|--------|-------|------|--------|
| **0** | Este documento | n/a | feito | ✅ |
| **1** | Puros `payload.js` (+ `reopenPolicy.js`) | baixo | `webhookZapiPure` | ✅ **FEITO** (2026-09-01) |
| **2** | `whatsappIdLookup.js` + `fromMeReconcile.js` (inclui mediaMatch) | médio | `webhookReconcileReferenceId` + pure | ✅ **FEITO** |
| **3** | `statusZapi.js` (ACK) | **alto** | `messageStatusHelper` + `disparoWebhookHook` | ✅ **FEITO** (2026-09-01). `statusApply` compartilhado adiado p/ a Fase 5 (está dentro do loop do `receberZapi`) |
| **4** | Standalone restantes: `log.js`, `disparoInbound.js`, payload-leftovers | baixo | gate completo | ✅ **FEITO** (2026-09-01). **A persistência/mídia REAL está DENTRO do `receberZapi`** → só sai na Fase 5 (não é bloco standalone) |
| **5** | Orquestrador `receberZapi` + shim | **muito alto** | todas as suites da §6 + `node --check` + load da fachada | **EM ANDAMENTO** (2026-09-01). Extraídos (verbatim, todos cobertos por testes): `instanceResolve.js` (tenant), `groupPhoto.js` (callback foto), **`disparoInbound.scheduleInboundDisparoHooks`** (Etapa 8 opt-out+resposta, fire-and-forget), **`historyImport.js`** (import de histórico ao abrir conversa nova), **`crmLeadInbound.js`** (captura de lead CRM) e **`groupSender.js`** (resolve remetente/membro em grupos — contrato→saída, com `tests/webhookGroupSender.test.js`). Controller **3.123 → 2.743** (15 módulos em `webhookInbound/`). Miolo caracterizado em `tests/receberZapiInbound.test.js`. **Ataque ao núcleo (abordagem A) iniciado:** a parte PURA do emit-tail (construção dos payloads `conversa_atualizada` + `nova_mensagem`) foi extraída para `realtimePayload.js` e travada com 11 testes (`webhookRealtimePayload.test.js`) — o emit-tail agora é só I/O + chamada aos builders testados. **Ainda inline (I/O acoplado):** carga da `convRow`, fallback de foto (query clientes), os `io.emit`/`emitirParaUsuariosQuePodemVerConversa`, e o insert/persistência (`persistMensagem` planejado) + reconcile `fromMe`. |

### Progresso (2026-09-01) — Fases 1 e 2 executadas

`controllers/webhookZapiController.js`: **4.598 → 3.220 linhas** (−30%). Criados em `controllers/webhookInbound/`:
- `payload.js` (606) — isGroupPayload, pickGroupChatId, looksLikeBRPhoneDigits, resolveConversationKeyFromZapi, extractMessage, getPayloads (puros).
- `reopenPolicy.js` (84) — normalizeReopenText, shouldReopenFinishedConversation (puros).
- `whatsappIdLookup.js` (179) — select/update/patch por whatsapp_id + filtro de instância; recebem `supabaseClient` por parâmetro.
- `fromMeReconcile.js` (270) — reconciliação fromMe + mediaMatch. **Importa** `supabase`, `messageStatusHelper` (normalizeRawAckStatus/statusRank), `whatsappMessageIdHelper` (5 fns), e o **sibling** `whatsappIdLookup` (applyWhatsappInstanceFilterOrLegacy, isLocalUploadMediaUrl).
- `statusZapi.js` (384) — **Fase 3**: handler de ACK completo (fallbacks prefixo/formato-WA/telefone/fila; sem regressão de status; emit `status_mensagem`; R2 mirror; disparoWebhookHook). Importa siblings `whatsappIdLookup` + `fromMeReconcile`, `messageStatusHelper`, resolução de instância; `_logWebhookSafe` duplicado (4 linhas). Reexportado pela fachada.

Contratos preservados: `receberZapi`/`statusZapi`/`_test` (15 chaves) reexportados; **11 suites / 171 testes verdes**.

**Armadilhas encontradas nesta quebra (para a próxima IA):**
1. Detector de fim de função por chaves precisa **ignorar `{}` de parâmetros destructurados** (`fn(row, { a, b })`) contando parênteses — senão corta a função no meio.
2. Fixar `require` dinâmicos internos `../` → `../../` ao descer para `controllers/webhookInbound/`.
3. Rodar um checker de **identificadores não-importados** no módulo novo: o webhook usa helpers de outros módulos (messageStatusHelper, sibling `whatsappIdLookup`, várias fns de `whatsappMessageIdHelper`) que o scan simples de imports do topo NÃO pega.
4. `WEBHOOK_MSG_SELECT` e `WHATSAPP_DEBUG` são usados por vários módulos → duplicar a const em cada (barato) e manter na fachada.

Não pular para a fase 5. Não “corrigir” fuso, fromMe, HTTP 500/200, nem unificar JID.

---

## 9. Como testar (depois de uma fase de código)

Além do gate da §6, smoke **homologação** (autorização explícita, número de teste):

1. Inbound texto `!fromMe` → uma linha, socket, unread.
2. Replay do mesmo `whatsapp_id` → sem segundo insert, **sem** novo menu URA.
3. Envio pelo CRM + eco `fromMe` → **uma** mensagem, `whatsapp_id` preenchido via `crm-*`.
4. ACK `device`/`read` → ticks; grupo não vira `read` global.
5. Campanha: inbound consome `aguardando_resposta_campanha` (some a tag); se houver `iniciado_por`/`criado_por` ativo na empresa, assume `em_atendimento` na Minha fila dele; senão `aberta` na fila geral. ACK atualiza fila sem `referenceId`.

Manual contra produção: **proibido** neste trabalho.
