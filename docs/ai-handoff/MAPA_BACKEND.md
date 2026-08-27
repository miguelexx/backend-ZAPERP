# Mapa de navegação do Backend

> Índice rápido para uma IA localizar **onde** está cada coisa antes de alterar.
> Criado: 2026-08-27 · `master` · commit-base `c7b92a0`.
> **Complementa** [`16-MAPA-DE-ARQUIVOS-CRITICOS.md`](16-MAPA-DE-ARQUIVOS-CRITICOS.md) (matriz de risco por arquivo) e [`../AUDITORIA_BACKEND.md`](../AUDITORIA_BACKEND.md) (desempenho/complexidade). Aqui é só "onde encontrar".

## chatController — modularização dos fluxos de LEITURA (2026-08-27)

`controllers/chatController.js` continua sendo a **fachada** (mesmos 63 exports, mesmas rotas). Os fluxos de leitura foram extraídos para `controllers/chat/`:

| Arquivo | Responsabilidade | Handlers / conteúdo |
|---|---|---|
| [`controllers/chat/shared.js`](../../controllers/chat/shared.js) | Helpers de **dados/leitura** compartilhados (sem socket, sem envio) | paginação/cursores, metadados de instância, enrich de mensagens, permissão/participação, unread, limites de busca, filtros |
| [`controllers/chat/listController.js`](../../controllers/chat/listController.js) | Listagem e contagem | `listarConversas` (GET /chats), `contarConversasPorFiltros` (GET /chats/counts) |
| [`controllers/chat/historyController.js`](../../controllers/chat/historyController.js) | Detalhe e histórico de mensagens | `detalharChat` (GET /chats/:id), `buscarMensagensConversa` (GET /chats/:id/messages/search) |

- A fachada reexporta: `chatController.listarConversas`, `.contarConversasPorFiltros`, `.detalharChat`, `.buscarMensagensConversa` — rotas e imports existentes **não mudam**.
- `chat/shared.js` é importado **tanto** pela fachada (write handlers) **quanto** pelos módulos de leitura → sem dependência circular (fachada → módulos → shared).
- Guard: [`tests/chatReadHandlersSmoke.test.js`](../../tests/chatReadHandlersSmoke.test.js) executa os 4 handlers end-to-end (pega import faltante após futuras extrações).
- **Ainda no chatController** (sessão 2): envio, mídia, ACK, sockets, chatbot, reações, encaminhar, contatos, tags, notas, assumir/encerrar/reabrir/transferir. Os helpers de socket (`emitir*`) permanecem lá.

## Pontos de entrada

| O quê | Onde |
|---|---|
| Boot HTTP + Socket.IO + schedulers + fail-fast de env | [`index.js`](../../index.js) |
| Pipeline Express (Helmet/CSP, parsers, CORS, static, erro global) | [`app.js`](../../app.js) |
| Montagem de rotas REST (e alias `/api`) | [`app.js`](../../app.js) L272–354 |
| Worker de Disparo (**processo separado**) | [`workers/disparoWorker.js`](../../workers/disparoWorker.js) |
| Worker de fila genérica (sync) — **mesmo processo** | [`services/queueManager.js`](../../services/queueManager.js) `startWorker` |

## Rotas → Controller (por prefixo em `app.js`)

| Prefixo HTTP | Rota | Controller principal |
|---|---|---|
| `/chats` | `routes/chatRoutes.js` | `controllers/chatController.js` (**god object** — ver auditoria) |
| `/webhooks/ultramsg`, `/webhooks/whatsapp` | `routes/webhookUltramsgRoutes.js` | `webhookUltramsgController.js` → `webhookZapiController.js` (**inbound/ACK ativo**) |
| `/dashboard` | `routes/dashboardRoutes.js` | `dashboardController.js` |
| `/ia`, `/ai` | `routes/iaRoutes.js`, `routes/aiRoutes.js` | `aiController.js` → `services/aiDashboardService.js` |
| `/config` | `routes/configRoutes.js` | `configController.js` |
| `/integrations/whatsapp`, `/integrations/zapi` | `routes/whatsappIntegrationRoutes.js` | `whatsappIntegrationController.js` |
| `/clientes` | `routes/clienteRoutes.js` | `clienteController.js` |
| `/usuarios` | `routes/userRoutes.js` | `userController.js` |
| `/tags` | `routes/tagRoutes.js` | `tagController.js` |
| `/chatbot`, `/chatbot/debug` | `chatbotManagementRoutes.js`, `chatbotDebugRoutes.js` | `chatbot*` |
| `/internal-chat` | `routes/internalChatRoutes.js` | `internalChatController.js` + `repositories/` + `socket/internalChatSocket.js` |
| `/supervisao` | `routes/supervisaoRoutes.js` | `supervisaoController.js` → `services/supervisaoService.js` |
| `/produtos` | `routes/produtosRoutes.js` | `produtosController.js` (integração externa) |
| `/helpdesk` | `routes/helpDeskRoutes.js` | `helpDeskController.js` |
| `/disparo` | `routes/disparoRoutes.js` | `controllers/disparo*Controller.js` (módulo em evolução) |
| `/media` | `routes/mediaProxyRoutes.js` | `mediaProxyController` (**SSRF sensível**; JWT em query → log) |
| `/push` | `routes/pushRoutes.js` | `pushController.js`, `fcmPushTokenController.js` |
| `/crm` | `routes/crmSsoRoutes.js` | `crmSsoController.js` (só SSO; CRM interno removido) |
| `/print` | `routes/printRoutes.js` | `printController.js` |
| `/opt-in`, `/opt-out` | `routes/optInOptOutRoutes.js` | consentimento de envio |

## Onde ficam as regras de negócio

| Domínio | Arquivos-chave |
|---|---|
| Localizar/criar/mesclar conversa | `helpers/conversationSync.js` (**crítico**), `helpers/phoneHelper.js` |
| Envio WhatsApp (provider único) | `services/providers/ultramsg.js`, `services/providers/index.js` |
| Instâncias UltraMSG por empresa | `services/whatsappInstanceService.js` (tabela `empresa_zapi`, nome legado) |
| Triagem/chatbot | `services/chatbotTriageService.js`, `services/regrasAutomaticasService.js` |
| Mídia inbound + espelho R2 + retenção | `services/inboundMediaPersistenceService.js`, `mediaR2MirrorService.js`, `mediaRetentionService.js`, `config/r2.js` |
| Reconciliação outbound (idempotência) | `services/pendingOutboundReconciliationService.js` |
| SLA / dashboard / supervisão | `services/slaCalculationService.js`, `dashboardController.js`, `services/supervisaoService.js` |
| IA analítica (read-only) | `services/aiDashboardService.js`, `services/openaiClient.js` |
| Fila de jobs (sync) | `services/queueManager.js`, `services/operationalRateLimiter.js` |
| Proteção de envio (**DESATIVADA**) | `services/protecao/protecaoOrchestrator.js` |

## Banco, tempo real, webhooks, jobs

| Camada | Onde |
|---|---|
| Cliente Supabase (SERVICE_ROLE, bypassa RLS) | `config/supabase.js` |
| Schema (fonte normativa) | `supabase/migrations/` (ordenadas por timestamp). `schema.sql` = só contexto |
| Socket.IO — salas, eventos, auth | `index.js` (`io.EVENTS`, `emitEmpresa/emitConversa/emitUsuario`), `socket/internalChatSocket.js` |
| Webhook inbound/ACK | `webhookUltramsgController.js` → `webhookZapiController.js` (`receberZapi`, `statusZapi`) |
| Schedulers (mesmo processo HTTP) | `services/*Scheduler.js`, registrados em `index.js` L398–417 |
| Auth JWT / tenant | `middleware/auth.js` |
| Rate limit / webhook token | `middleware/rateLimit.js`, `middleware/requireWebhookToken.js` + resolvers |
| Feature flags / env | `helpers/featureFlags.js`, `config/env.js` |
| Permissões granulares | `helpers/permissoesCatalogo.js`, `helpers/permissoesService.js` |

## Onde alterar cada módulo

| Tarefa | Começar em |
|---|---|
| Nova rota | `routes/*.js` + controller |
| Nova regra de negócio | `services/` (nunca dentro do controller) |
| Novo campo no banco | migration em `supabase/migrations/` (aplicar **antes** do deploy) |
| Novo evento Socket.IO | `index.js` (`io.EVENTS`) + emitir na sala mínima |
| Nova variável de ambiente | `config/env.js` + doc `10-CONFIGURACAO-E-AMBIENTES.md` |
| Novo scheduler | `services/*Scheduler.js` + registrar em `index.js` |
| Nova permissão | `helpers/permissoesCatalogo.js` |
| Novo tipo de mídia | `middleware/upload.js` + `helpers/audioFormatSniffer.js` |

## Arquivos críticos (não quebrar)

`index.js` · `app.js` · `middleware/auth.js` · `config/supabase.js` · `services/providers/ultramsg.js` · `helpers/conversationSync.js` · `helpers/phoneHelper.js` · `services/whatsappInstanceService.js` · `controllers/webhookZapiController.js` · `controllers/chatController.js`. Detalhe e cuidados: [`16-MAPA-DE-ARQUIVOS-CRITICOS.md`](16-MAPA-DE-ARQUIVOS-CRITICOS.md).

## Contratos que não podem ser quebrados

Ver [`18-ANTI-PADROES-E-ARMADILHAS.md`](18-ANTI-PADROES-E-ARMADILHAS.md). Resumo: `company_id` sempre do JWT · status de mensagem unidirecional · idempotência por `client_temp_id`/`referenceId` (sem retry cego) · dedup por `whatsapp_id` **antes** de side effects · listeners socket só no boot · `instances: 1` sem Redis · migrations antes do deploy.

## Testes a rodar antes de mexer em cada área

Tabela completa em [`../AUDITORIA_BACKEND.md`](../AUDITORIA_BACKEND.md) §8. Comando seguro (mock do Supabase, sem schedulers/worker):

```bash
ZAPERP_DISABLE_BACKGROUND_JOBS=true npx jest --runInBand
```
Estado atual: **105 suites / 1095 testes passando** (Jest não encerra limpo — handle aberto conhecido).
