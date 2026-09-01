# 23 — Chat HTTP: mapa da modularização

> Atualizado: **2026-09-01**. Fonte: código atual (`controllers/chatController.js` + `controllers/chat/` + `services/chat/`).  
> Mapa por arquivo/função: [`docs/CHAT_ARQUITETURA_MODULAR.md`](../CHAT_ARQUITETURA_MODULAR.md).

Rotas: [`routes/chatRoutes.js`](../../routes/chatRoutes.js) continuam apontando para `controllers/chatController.js`.  
A fachada é um **shim (~412 linhas)**: reexports dos sub-controllers + 6 helpers de realtime/visibilidade + `exports._test`. **Não há handler HTTP inline.**

> **Não reextrair** `listarConversas`, `enviarMensagemChat` nem o trio PIX da fachada — já estão em `controllers/chat/`.  
> Referência por arquivo/função + armadilhas: [`docs/CHAT_ARQUITETURA_MODULAR.md`](../CHAT_ARQUITETURA_MODULAR.md).  
> Baseline de testes (quando a extração foi feita): **185/185** (inclui `idempotencyService`, `enviarMensagemChat`, `listarConversasFilters`). Não reler 178 como número atual.

**Working tree (não descartar):** `git status` antes de qualquer edição. Em 2026-09-01 estes três podem estar **untracked**:

- `controllers/chat/conversationListController.js` — `listarConversas`
- `controllers/chat/textMessageController.js` — `enviarMensagemChat`
- `controllers/chat/pixController.js` — `getPixConfig` / `putPixConfig` / `enviarMensagemPix`

Já **no Git:** `mediaMessageController.js`, `idempotencyService.js`, `tests/idempotencyService.test.js`, `tests/enviarMensagemChat.test.js`.

Não misturar com Sessão B da IA nem com UltraMSG.

---

## 1. O que já saiu da fachada

| Arquivo | Handlers reexportados pela fachada |
|---------|--------------------------------------|
| `chat/conversationListController.js` | `listarConversas` (**não reextrair**) |
| `chat/textMessageController.js` | `enviarMensagemChat` (**não reextrair**) |
| `chat/pixController.js` | `getPixConfig`, `putPixConfig`, `enviarMensagemPix` (**não reextrair**; Pix delega ao sibling de texto) |
| `chat/integrationController.js` | instâncias, `whatsappStatus` / alias `zapiStatus`, sync contatos/fotos |
| `chat/contactController.js` | grupo, comunidade, contato, abrir conversa, vincular cliente, nome, observação |
| `chat/preferencesController.js` | `patchConversaPrefs` |
| `chat/conversationCleanupController.js` | limpar mensagens, apagar conversa |
| `chat/conversationDetailController.js` | `detalharChat` |
| `chat/messageReadController.js` | sync-old, busca de mensagens na conversa |
| `chat/attendanceController.js` | assumir/encerrar/reabrir/transferir, estados manuais, co-atendentes, nota, setor |
| `chat/attendanceQueueController.js` | `listarAtendimentos`, `puxarChatFila` |
| `chat/outboundController.js` | reação, contato WhatsApp, localização, ligação |
| `chat/messageDeletionController.js` | `excluirMensagem` |
| `chat/tagsController.js` | tags da conversa |
| `chat/forwardController.js` | `encaminharMensagem` |
| `chat/batchOpsController.js` | contagem por filtro, finalização ausência em lote |
| `chat/retryController.js` | retry texto/mídia |
| `chat/maintenanceController.js` | merge duplicatas |
| `chat/mediaMessageController.js` | `enviarArquivo` |

`routes` **não** mudaram de path. Jest que faz `require('../controllers/chatController')` continua válido.

---

## 2. O que ainda está na fachada (`chatController.js`)

**CONFIRMADO:** a fachada **é shim**. Não hospeda `listarConversas` / `enviarMensagemChat` / PIX.

Ainda no arquivo (de propósito):

- Reexport dos sub-controllers acima
- 6 helpers de contrato legado (webhook/push/sync importam da fachada): `emitirEventoEmpresaConversa`, `emitirRealtimeAposAssumir`, `emitirMovimentacaoInternaAtendimento`, `incrementarUnreadParaConversa`, `emitirParaUsuariosQuePodemVerConversa`, `obterUsuarioIdsQuePodemVerConversa`
- `exports._test` — funções puras reimportadas de `services/chat/**` para testes que leem `chatController._test`

O topo ainda tem **muitos `require` que os handlers extraídos já não usam** (sobraram para `_test` e por extração verbatim). Encolher isso é opcional e separado; **não** é “extrair lista/texto de novo”.

---

## 3. Services extraídos (`services/chat/`)

Usados pelos sub-controllers **e** pela fachada (`_test` + helpers). Não duplicar.

| Pasta | Papel |
|-------|--------|
| `access/` | política de envio/visão (`conversationPolicy`, `conversationVisibilityService`) |
| `identity/` | telefone/LID/instância da conversa |
| `media/` | tipo e normalizadores |
| `outbound/` | normalizers, mapper UltraMSG, forward, modo simples, PIX helper, retry, `idempotencyService` |
| `presentation/` | DTO da lista, enriquecimento de autor |
| `read/` | paginação, limites de busca, filtros da lista, lookups |
| `realtime/` | `chatRealtimeGateway` — emitir Socket; **não** instalar listener por request |
| `unread/` | unreads da conversa |

`mapProviderSendResult` existe em `outbound/providerResultMapper.js`; os endpoints de envio **ainda não** passaram a usá-lo (Fase 6 interna). Não “ligar” no split.

---

## 4. Invariantes

1. `company_id` só do JWT.
2. Status de mensagem não regride; `client_temp_id` + `referenceId`; nunca retry cego no provider.
3. `io` via `req.app.get('io')` — nunca variável `io` solta (anti-padrão 16).
4. Alias `zapiStatus` permanece.
5. Grupos visuais / não encerráveis; `whatsapp_instance_id` na identidade da conversa.
6. Não unificar JID de envio/foto/histórico no UltraMSG ([21](21-ULTRAMSG-PROVIDER-MODULARIZACAO.md)).
7. Emissão otimista `nova_mensagem` **antes** de `provider.sendText` é intencional — não “corrigir” na extração interna.

---

## 5. Próximo passo (quando o Miguel pedir)

1. `git status` — **não descartar** os três untracked de lista/texto/PIX.
2. Commit desses arquivos + fachada + estes docs, **só com autorização**.
3. **Não** reextrair handlers da fachada. Opcional depois: decomposição **interna** de `listarConversas` / `enviarMensagemChat` (ver `CHAT_ARQUITETURA_MODULAR.md` §4), com caracterização; encolher requires mortos do shim.
4. Não juntar com Sessão B de [`22`](22-AI-DASHBOARD-MODULARIZACAO.md).
