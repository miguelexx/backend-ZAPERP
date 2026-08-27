# Mapa de arquivos críticos

> Análise: 2026-08-23 · `master` · commit-base `66e0771d9f61f840524cd4b0645e742df374a77a`.

| Arquivo/caminho | Responsabilidade / módulos | Risco | Testes e cuidado obrigatório |
|---|---|---|---|
| `index.js` | boot HTTP, Socket.IO, env e schedulers | crítico | `auth`, socket, schedulers; manter fail-fast e uma instalação de handlers/jobs. |
| `app.js` | pipeline Express, mounts, segurança, static/health | crítico | `auth`, `health`, CSP/uploads; preservar ordem webhook→CORS/logger e aliases `/api`. |
| `middleware/auth.js` | JWT/tenant | crítico | `auth`, `productionAuthorization`, CRM; nunca aceitar tenant externo. |
| `middleware/requireWebhookToken.js` + resolvers | autenticação/resolução webhook | crítico | webhook/auth/multi-instância; timing-safe, fail closed, sem token em log. |
| `middleware/rateLimit.js` | buckets/limites em memória | alto | `rateLimitBucket`; mudanças afetam disponibilidade e proxy/IP. |
| `controllers/chatController.js` | conversas, atendimento, envio/mídia | crítico | muitas suites `chat*`, mensagem, mídia; controller monolítico, mapear service/socket/provider antes de editar. |
| `controllers/webhookUltramsgController.js` | normalização UltraMSG | crítico | `disparoUltramsgReferenceId`, webhooks; manter formatos e contexto resolvido. |
| `controllers/webhookZapiController.js` | domínio inbound/ACK legado | crítico | ACK/inbound/fromMe; nome legado, mas caminho ativo. Não remover por nome. |
| `services/providers/ultramsg.js` | chamadas externas, normalização de resposta | crítico | `ultramsgProviderInstanceResolution`; sempre mock, mascarar token, preservar `referenceId`. |
| `services/whatsappInstanceService.js` | instâncias/default/duplicidade | crítico | `whatsappInstanceService`, multi-instância; filtrar empresa e bloquear duplicidade normalizada. |
| `helpers/conversationSync.js` | localizar/criar/mesclar conversa | crítico | `conversasOpenUniqueMultiInstance`, operational phase; telefone+instância+tenant. |
| `helpers/phoneHelper.js` | normalização de telefone (inbound, busca, criação de contato) | crítico | qualquer alteração pode quebrar matching de tenant; usado no webhook inbound antes de associar ao company. |
| `helpers/permissoesCatalogo.js` | catálogo de permissões granulares | alto | toda lógica de autorização granular depende deste catálogo; ao adicionar permissão nova, começar aqui. |
| `helpers/featureFlags.js` | feature flags operacionais (`FEATURE_PROTECAO`, `FEATURE_REGRA_AUTO_WEBHOOK`, etc.) | alto | controla comportamento do chatbot e proteção de envio; verificar antes de depender de feature nova. |
| `helpers/chatSearchHelper.js` | busca de conversas (unaccent, relevância, prefixo) | alto | lógica complexa alterada recentemente (migrations 20260810–20260823); tocar requer entender as 3 camadas (nome, telefone, texto). |
| helpers de status/id | monotonicidade e identificação externa | alto | `messageStatusHelper`, `whatsappMessageIdHelper`; ACK atrasado não pode regredir. |
| `socket/` e `helpers/socketEvents.js` | salas, presença, eventos | crítico | testes socket/chat interno; sala mínima, payload tenant-safe, listener único. |
| `config/supabase.js` | cliente privilegiado | crítico | mock global; nunca expor service role, timeout/filtros obrigatórios. |
| `supabase/migrations/` | schema canônico | crítico | testes de SQL textuais; validar ordem/estado real, não executar automaticamente. |
| `supabase/schema.sql` | fotografia contextual antiga | médio | não usar como estado final; comparar migrations. |
| `middleware/upload*.js` | upload geral/disparo | alto | mídia, ZIP, magic bytes; tamanho, temporário e cleanup. |
| `services/inboundMediaPersistenceService.js` | download seguro/retry | crítico | `inboundMediaPersistence`, áudio, SSRF; revalidar redirect/host e remover parcial. |
| `controllers/mediaProxyController.js` / `routes/mediaProxyRoutes.js` | proxy autenticado | alto | `mediaProxy*`; evitar token em query/log e SSRF. |
| `config/r2.js`, `services/storage/r2Client.js`, mirror/retention | storage/assinatura/remoção | crítico | suites R2; não habilitar rollout/retenção automaticamente. |
| `workers/disparoWorker.js` | loop/claim/lease/envio campanha | crítico | loop embarcado no HTTP + processo opcional; manter três gates de live e anti-reenvio incerto. |
| `services/disparoFilaService.js`, `disparoSendService.js` | fila/idempotência/envio | crítico | `disparoFilaService`, `disparoSendService`; teste live mock atualmente divergente. |
| `services/disparoOptOutService.js`, reconciliação | exclusão, resposta, incerto | crítico | opt-out/reconciliação; comando exato, tenant, terminalidade. |
| `controllers/disparoSaudeController.js`, `helpers/disparoObservabilidade.js` | health Etapa 9 | crítico | novos testes de isolamento; heartbeat global hoje expõe metadado cross-tenant. |
| `services/*Scheduler.js`, `jobs/`, `controllers/jobsController.js` | tarefas em processo/cron | alto | suites de scheduler/cron; desligar em teste, evitar execução duplicada. |
| `ecosystem.config.js` | topologia PM2 | crítico operacional | manter `instances: 1` até coordenação distribuída. |
| `.env.example` | catálogo operacional | alto segurança | nunca copiar valor; contém exemplo credential-shaped a revisar. |
| `tests/setup.js` | mock global Supabase | alto para confiança | testes podem passar sem RLS/SQL real; não confundir mock com integração. |
| **`controllers/webhookController.js`** | **shim legado — retorna 410** | **nenhum** | **NÃO está montado em `app.js`. Existe apenas como guard: retorna `410 Gone` se chamado diretamente. Não é o handler ativo. Não remover sem confirmar que nada o importa, mas também não editar — é intencionalmente vazio.** |

