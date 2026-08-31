# 23 — Chat HTTP: mapa da modularização

> Atualizado: **2026-08-31**. Fonte: código atual (`controllers/chatController.js` + `controllers/chat/` + `services/chat/`).  
> Plano histórico (auditoria do monolito ~10k linhas, **antes** da quebra): [`docs/CHAT_CONTROLLER_MODULARIZACAO.md`](../CHAT_CONTROLLER_MODULARIZACAO.md) — números de linha dali **não** valem mais.

Rotas: [`routes/chatRoutes.js`](../../routes/chatRoutes.js) continuam apontando para `controllers/chatController.js`.  
A fachada caiu de ~10.062 → **~2.503 linhas**. Ainda hospeda inline apenas `listarConversas`, `enviarMensagemChat`, o trio PIX e `exports._test`.

> **Referência detalhada (cada arquivo e cada função + padrão de extração + armadilhas):**
> [`docs/CHAT_ARQUITETURA_MODULAR.md`](../CHAT_ARQUITETURA_MODULAR.md). Leia antes de fatiar `listarConversas`/`enviarMensagemChat`.
> Baseline de testes: **178/178 verdes** (inclui `idempotencyService` e `listarConversasFilters`).

**Working tree (não descartar):** estes arquivos já existem, mas podem estar **não commitados** — `git status` antes de qualquer edição:
- `controllers/chat/mediaMessageController.js` (Fase 7 — `enviarArquivo` + `enviarArquivoProcessarUm`)
- `services/chat/outbound/idempotencyService.js` (+ `modoSimplesOutbound.js`) e `tests/idempotencyService.test.js`

Não misturar isso com Sessão B da IA nem com UltraMSG.

---

## 1. O que já saiu da fachada

| Arquivo | Handlers reexportados pela fachada |
|---------|--------------------------------------|
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
| `chat/mediaMessageController.js` | `enviarArquivo` (Fase 7; **pode estar só no working tree**) |

`routes` **não** mudaram de path. Jest que faz `require('../controllers/chatController')` continua válido.

---

## 2. O que ainda está na fachada (`chatController.js`)

**CONFIRMADO** no código da fachada (ainda não é shim fino):

- `listarConversas` (lista/filtros/paginação — o bloco mais pesado que restou)
- PIX: `getPixConfig`, `putPixConfig`, `enviarMensagemPix`
- `enviarMensagemChat` (texto)
- helpers de realtime/unread no topo e `exports._test` (contrato dos testes atuais)

`enviarArquivo` saiu para `mediaMessageController.js` quando esse arquivo existir (reexport na fachada). Não transformar a fachada em shim até lista/texto/PIX terem dono claro e as suites `chat*` verdes.

---

## 3. Services extraídos (`services/chat/`)

Usados pelos controllers fatiados **e** pela fachada. Não duplicar.

| Pasta | Papel |
|-------|--------|
| `access/` | política de envio/visão (`conversationPolicy`, `conversationVisibilityService`) |
| `identity/` | telefone/LID/instância da conversa |
| `media/` | tipo e normalizadores |
| `outbound/` | normalizers, mapper de resultado UltraMSG, forward, modo simples, PIX helper, retry eligibility, idempotência (helpers commitados; `idempotencyService.js` pode estar só no working tree) |
| `presentation/` | DTO da lista, enriquecimento de autor |
| `read/` | paginação, limites de busca, filtros da lista, lookups |
| `realtime/` | `chatRealtimeGateway` — emitir Socket; **não** instalar listener por request |
| `unread/` | unreads da conversa |

---

## 4. Invariantes (iguais às do chat “monolito”)

1. `company_id` só do JWT.
2. Status de mensagem não regride; `client_temp_id` + `referenceId`; nunca retry cego no provider.
3. `io` via `req.app.get('io')` — nunca variável `io` solta (anti-padrão 16).
4. Alias `zapiStatus` permanece.
5. Grupos visuais / não encerráveis; `whatsapp_instance_id` na identidade da conversa.
6. Não unificar JID de envio/foto/histórico no UltraMSG ([21](21-ULTRAMSG-PROVIDER-MODULARIZACAO.md)).

---

## 5. Próximo passo (quando o Miguel pedir)

1. `git status` — preservar idempotência não commitada.
2. Extrações restantes na fachada: **lista**, **texto**, **PIX** — uma família por vez, com as suites `chat*` / mensagem / mídia.
3. Não juntar com Sessão B de [`22`](22-AI-DASHBOARD-MODULARIZACAO.md).
