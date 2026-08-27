# AI_HANDOFF — Backend ZapERP

> Contexto compacto para IAs começarem sem redescobrir o sistema.  
> Atualizado: **2026-08-24** · branch `master`.  
> Para análise completa, use [`ai-handoff/00-LEIA-PRIMEIRO.md`](ai-handoff/00-LEIA-PRIMEIRO.md).

---

## O que é o ZapERP

Plataforma **SaaS multi-tenant** de atendimento via WhatsApp. Cada empresa (`company_id`) tem instâncias UltraMSG próprias, usuários, conversas, contatos e configurações isolados. O backend fornece API HTTP, webhooks e eventos Socket.IO em tempo real.

---

## Stack

| Componente | Versão/detalhe |
|-----------|----------------|
| Runtime | Node.js 18+ (recomendado 20+) |
| Framework | Express 4 + `express-async-errors` |
| Banco | Supabase (PostgreSQL) via `@supabase/supabase-js` com `SERVICE_ROLE_KEY` |
| Realtime | Socket.IO 4.7 (adapter em memória — processo único) |
| WhatsApp | UltraMSG (único provider ativo) |
| Mídia | Disco local `/uploads` + espelhamento opcional Cloudflare R2 |
| IA | OpenAI (opcional; só com `OPENAI_API_KEY`) |
| Auth | JWT (`jsonwebtoken`) com `JWT_SECRET` |
| Push | Web Push (VAPID) + Firebase FCM |
| Processo | PM2 modo `fork`, 1 instância (`ecosystem.config.js`) |

---

## Arquitetura em camadas

```
Cliente (SPA/Socket) → Express (app.js) → Controllers → Services/Helpers → Supabase
                                         ↓
                               Socket.IO (index.js)
                                         ↓
                          Schedulers + Worker de Disparo
```

- `app.js` — segurança (Helmet, CSP), parsers, webhooks **antes** do CORS, rotas REST, estáticos (`/uploads`), handler de erro global
- `index.js` — fail-fast de env, Socket.IO, autenticação de socket, salas, eventos, boot de schedulers
- `workers/disparoWorker.js` — loop da fila de campanhas (embarcado no HTTP; processo separado opcional)

---

## Estrutura de pastas

```
backend/
├── app.js                  # Express: segurança, rotas, estáticos, erro global
├── index.js                # HTTP+Socket.IO, schedulers, boot
├── config/                 # env.js, supabase.js, r2.js, uploadsRoot.js, produtosDb.js, wmSqlServer.js
├── controllers/            # Camada HTTP — orquestração, validação, resposta
├── services/               # Regras de negócio reutilizáveis, integrações, schedulers
│   ├── providers/          # ultramsg.js (único provider ativo)
│   ├── protecao/           # frequência, volume, opt-in para Disparo
│   └── storage/            # r2Client.js
├── helpers/                # Normalização, status, payloads, permissões, telefone
├── middleware/             # auth.js, adminOnly, supervisorOrAdmin, upload, rateLimit, webhook*
├── routes/                 # Um arquivo por módulo
├── repositories/           # Persistência estruturada (chat interno)
├── workers/                # disparoWorker.js
├── socket/                 # internalChatSocket.js
├── validators/             # Validações Zod/schema
├── supabase/
│   ├── migrations/         # Fonte normativa do schema (ordem importa)
│   └── schema.sql          # Contextual apenas — pode divergir das migrations
├── tests/                  # Jest + supertest (~100 suites)
├── docs/                   # Esta pasta
└── scripts/                # Admin, certificação, carga
```

---

## Autenticação e multitenancy

- **REST:** `Authorization: Bearer <JWT>`. Middleware `middleware/auth.js` verifica `JWT_SECRET` e extrai `company_id` (obrigatório e numérico) e `departamento_ids`.
- **Socket.IO:** `socket.handshake.auth.token` — mesmo JWT. `company_id` obrigatório.
- **Service role:** `SUPABASE_SERVICE_ROLE_KEY` ignora RLS. **Todo isolamento depende de filtro explícito `company_id` no código.**
- **Perfis:** `admin` > `supervisor` > `atendente`. Permissões granulares via `usuario_permissoes`.

### Regra de ouro — multitenancy

> `company_id` DEVE ser derivado do JWT/token/instância. Nunca de `req.body` ou `req.query`.  
> Toda query de negócio DEVE incluir `company_id` no filtro.

---

## Módulos principais (estado atual — 2026-08-24)

| Módulo | Status | Arquivos-chave |
|--------|--------|----------------|
| Conversas/atendimentos | Estável | `chatController`, `atendimentosRegistroService` |
| Mensagens/mídia | Estável | `chatController`, `inboundMediaPersistenceService`, `mediaR2MirrorService` |
| UltraMSG/webhooks | Estável | `webhookUltramsgController`, `webhookZapiController`, `services/providers/ultramsg.js` |
| Chatbot/triagem | Estável | `chatbotTriageService`, `regrasAutomaticasService` |
| Clientes/contatos/tags | Estável | `clienteController`, `clienteImportController`, `tagController` |
| Usuários/config | Estável | `userController`, `configController`, `permissoesController` |
| Dashboard/SLA/supervisão | Estável | `dashboardController`, `supervisaoController`, `slaCalculationService` |
| Disparo (campanhas) | **Em evolução** | `controllers/disparo*`, `services/disparo*`, `workers/disparoWorker.js` |
| Chat interno | Estável | `internalChatController`, `repositories/`, `socket/internalChatSocket.js` |
| Help desk | Estável | `helpDeskController`, `helpDeskNotificationController` |
| Push (Web + FCM) | Estável | `pushController`, `fcmPushTokenController`, `webPushService`, `pushNotificationService` |
| Produtos | Estável (integração externa) | `produtosController`, `produtosSyncService` |
| IA analítica | Estável (opcional) | `aiController`, `openaiClient` |
| CRM SSO | Estável (CRM interno removido) | `crmSsoController` |
| Mídia R2 | Estável (rollout gated) | `mediaR2MirrorService`, `mediaRetentionService`, `config/r2.js` |
| Proteção de envio | **DESATIVADO** (`PROTECAO_DESATIVADA=true`) | `services/protecao/protecaoOrchestrator.js` + `frequenciaService`, `volumeService`, `optInService` |

### Módulos removidos (migrations 20260812*)

- `campanhas` / `campanha_envios` — tabelas dropadas; substituídas pelo módulo **Disparo**
- CRM interno (`crm_*` services) — removido; mantido apenas SSO para CRM externo
- `empresas_whatsapp` legado — dropado
- `planos` — dropado
- `scheduler_locks` users — dropado
- `empresas.crm_habilitado` — coluna dropada

---

## Banco de dados — tabelas principais

| Tabela | Domínio |
|--------|---------|
| `empresas` | Tenant root |
| `usuarios`, `usuario_departamentos`, `usuario_permissoes` | Usuários e permissões |
| `departamentos` | Setores por empresa |
| `clientes` | Contatos WhatsApp |
| `conversas` | Thread de atendimento |
| `mensagens` | Mensagens (inbound/outbound); `direcao`, `whatsapp_id`, `status`, `tipo`, `url` |
| `atendimentos` | Histórico de ações (assumiu, transferiu, encerrou, reabriu) |
| `empresa_zapi` | Credenciais UltraMSG por empresa (nome legado; ver ADR) |
| `jobs` | Fila de tarefas assíncronas |
| `ia_config`, `regras_automaticas`, `bot_logs` | Chatbot/IA |
| `tags`, `conversa_tags`, `cliente_tags` | Etiquetas |
| `conversa_unreads` | Contadores por usuário |
| `push_subscriptions`, `push_tokens` | Push notifications |
| `helpdesk_tickets`, `helpdesk_*` | Help desk |
| `internal_conversations`, `internal_messages` | Chat interno |
| `disparo_campanhas`, `disparo_fila`, `disparo_*` | Módulo de disparo |
| `auditoria_log`, `webhook_logs`, `auditoria_eventos` | Observabilidade |
| `contato_opt_in`, `contato_opt_out` | Consentimento de envio comercial (opt-in/opt-out) |

**Fonte normativa:** `supabase/migrations/` (ordenadas por timestamp). `schema.sql` é apenas contextual.

---

## Fluxos críticos

### Mensagem inbound (UltraMSG → sistema)

```
POST /webhooks/ultramsg
  → webhookLimiter
  → webhookBodyResolver (normaliza form/JSON)
  → requireWebhookToken
  → resolveWebhookCompany (instanceId → company_id)
  → webhookUltramsgController
      → normalizeUltramsgToZapi
      → webhookZapiController.receberZapi
          → upsert cliente
          → upsert conversa
          → insert mensagem (dedup por whatsapp_id)
          → chatbotTriageService (se aplicável)
          → inboundMediaPersistenceService (mídia)
          → io.emitEmpresa / io.emitConversa (socket)
```

### Mensagem outbound (atendente → UltraMSG)

```
POST /chats/:id/mensagens (ou /arquivo, /pix, etc.)
  → auth middleware
  → chatController
      → valida tenant/acesso
      → insert mensagem (status=pending, client_temp_id)
      → provider.sendMessage (UltraMSG)
      → atualiza mensagem (whatsapp_id, status=sent)
      → io.emitConversa (nova_mensagem)
      ← ACK via webhook → statusZapi → atualiza status
```

### Socket.IO — salas

| Sala | Membros |
|------|---------|
| `empresa_{company_id}` | Todos os usuários do tenant |
| `usuario_{user_id}` | Usuário específico |
| `departamento_{dep_id}` | Usuários do setor |
| `conversa_{id}` | Após `join_conversa` autorizado |
| `internal_user_{id}` | Chat interno |

### Disparo (fila no processo HTTP)

1. API cria campanha → configura destinatários → instâncias → variações → limites → revisão → confirma
2. `POST /disparo/campanhas/:id/execucao/iniciar` muda status para `em_execucao` e acorda o loop (`kickWorker`)
3. `disparoWorker.js` processa a fila no mesmo processo HTTP (`startEmbeddedWorker`). `npm run worker:disparo` é opcional
4. **Gates de envio real:** `DISPARO_WORKER_ENABLED=true` + `DISPARO_LIVE_ENABLED=true` + `DISPARO_DRY_RUN=false`

---

## Schedulers e background jobs

| Job | Frequência | Efeito |
|-----|-----------|--------|
| fila genérica | poll 5s | sync_contatos, sync_fotos, etc. |
| **Disparo (fila de campanhas)** | poll 2s + kick ao iniciar | processa `disparo_fila_itens` neste processo |
| finalização ausência | 5 min | encerra conversas sem resposta |
| alerta admin | 2 min | detecta atendimentos sem resposta |
| atendimento sem resposta | 1 min | alertas e sockets |
| reconciliação outbound pendente | 5 min | reclassifica mensagens pendentes |
| redirecionamento triagem | 1 min | move conversas sem escolha |
| retry inbound | 1 min / 3h | reprocessa mídia inbound |
| mirror R2 | 5 min | copia mídia para R2 |
| retenção R2 | 24h | remove mídia vencida (padrão: desligado) |

Todos no mesmo processo HTTP. Reinício perde estado em memória. Não há Redis.

---

## Variáveis de ambiente obrigatórias

| Variável | Finalidade |
|----------|-----------|
| `NODE_ENV` | `production` / `development` |
| `PORT` | Porta HTTP (padrão 3000) |
| `APP_URL` | URL pública do backend |
| `JWT_SECRET` | Assinar/verificar JWTs |
| `WHATSAPP_WEBHOOK_TOKEN` | Autenticar webhooks UltraMSG |
| `SUPABASE_URL` | URL do projeto Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Chave service role (bypass RLS) |
| `CORS_ORIGINS` | Origens frontend (CSV) |

Manifesto completo: [`ai-handoff/10-CONFIGURACAO-E-AMBIENTES.md`](ai-handoff/10-CONFIGURACAO-E-AMBIENTES.md)

---

## Como executar

```bash
# Instalar dependências
npm ci

# Desenvolvimento
npm run dev

# Produção (PM2)
npm start

# Worker de disparo (processo separado)
npm run worker:disparo

# Testes
npm test
```

---

## Onde alterar cada coisa

| Tarefa | Onde começar |
|--------|-------------|
| Nova rota | `routes/*.js` + controller correspondente |
| Nova regra de negócio | `services/` (separar de controller) |
| Novo campo no banco | Migration em `supabase/migrations/` |
| Novo evento Socket.IO | `index.js` (io.EVENTS + emitir no service/controller) |
| Nova variável de ambiente | `config/env.js` + documentar em `10-CONFIGURACAO-E-AMBIENTES.md` |
| Novo scheduler | `services/*Scheduler.js` + registrar em `index.js` |
| Nova permissão | `helpers/permissoesCatalogo.js` |
| Novo tipo de mídia | `middleware/upload.js` + `helpers/audioFormatSniffer.js` |
| Manutenção / diagnóstico / R2 | `scripts/` — ver catálogo em [`reference/SCRIPTS-CATALOG.md`](reference/SCRIPTS-CATALOG.md) |
| Ativar proteção de envio (rate limit) | `services/protecao/protecaoOrchestrator.js` — ver [`reference/PROTECAO-ENVIO.md`](reference/PROTECAO-ENVIO.md) |

---

## Arquivos que devem ser lidos antes de qualquer mudança

1. `index.js` — boot, Socket.IO, schedulers
2. `app.js` — Express, middlewares, rotas montadas
3. `middleware/auth.js` — autenticação JWT
4. `config/supabase.js` — cliente Supabase (service role)
5. `services/providers/ultramsg.js` — provider WhatsApp
6. Migration mais recente em `supabase/migrations/` para o domínio afetado
7. Testes existentes do módulo (pasta `tests/`)
8. [`ai-handoff/13-PROBLEMAS-CONHECIDOS-E-DIVIDA-TECNICA.md`](ai-handoff/13-PROBLEMAS-CONHECIDOS-E-DIVIDA-TECNICA.md) — riscos conhecidos

---

## Regras que nunca podem ser quebradas

1. **`company_id` obrigatório em toda query de negócio** — derivado de JWT/token, nunca de body/query
2. **Não regredir status de mensagem** — `pending → sent → delivered → read` é unidirecional
3. **`client_temp_id` + `referenceId` para idempotência** — nunca retry cego em envio
4. **Não aplicar migrations em produção** sem inventário real e autorização explícita
5. **Não commitar/pushar** sem autorização do usuário
6. **Não expor `SUPABASE_SERVICE_ROLE_KEY`** em logs, respostas ou documentação
7. **Envio real de Disparo tem 3 gates** — `DISPARO_WORKER_ENABLED`, `DISPARO_LIVE_ENABLED`, `DISPARO_DRY_RUN` — todos devem ser conscientemente configurados. A fila em si roda no HTTP.
8. **Migrations são a fonte do schema** — `schema.sql` é só contexto

---

## Riscos conhecidos (top 5)

1. **Service role ignora RLS** — bug em qualquer filtro `company_id` = vazamento entre tenants
2. **Estado em memória** — schedulers, rate limit, presença e dedupe perdem estado no restart; não escala horizontalmente
3. **Sem transação distribuída** — mensagem outbound pode ficar em estado incerto entre banco e UltraMSG
4. **JWT não revogável** — usuário desativado mantém acesso até expirar
5. **Etapa 9 de Disparo** — código no working tree espera migration `20260823120000` aplicada no banco real

Detalhes: [`ai-handoff/13-PROBLEMAS-CONHECIDOS-E-DIVIDA-TECNICA.md`](ai-handoff/13-PROBLEMAS-CONHECIDOS-E-DIVIDA-TECNICA.md)

---

## Dívidas técnicas e pendências

- [ ] Migrations do Disparo (etapas 5–9) precisam ser aplicadas no banco real antes de ligar o worker live
- [ ] `helpdesk_notificacoes` — tabela não encontrada nas migrations; localizar origem
- [ ] `build_sha` ausente no health check
- [ ] SSRF proxy: resolver DNS antes de conectar; bloquear IPv6 privado
- [ ] Jest não encerra limpo (handle aberto); rodar com `--detectOpenHandles` para diagnosticar
- [ ] `disparoRevisao.test.js` — erro de mock no export não exercita o caminho de sucesso

---

## Checklist antes de implementar qualquer mudança

- [ ] `git status` — distinguir mudanças preexistentes; não descartar trabalho do usuário
- [ ] Rastrear rota → controller → service → migration → teste
- [ ] Confirmar filtros `company_id` em todas as queries novas/modificadas
- [ ] Mapear impacto em persistência, provider, webhook, socket, jobs e reconciliação
- [ ] Escrever ou atualizar testes (mock Supabase/provider/push/R2)
- [ ] Não executar migrations, deploy, envio real, commit ou push sem autorização explícita
- [ ] Atualizar documentação em `docs/ai-handoff/` no mesmo trabalho

---

*Para análise completa por módulo, leia [`ai-handoff/`](ai-handoff/) — 17 documentos especializados.*
