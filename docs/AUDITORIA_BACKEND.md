# Auditoria Técnica do Backend — ZapERP

> **Escopo:** auditoria de desempenho, complexidade, organização, concorrência e risco.
> **Data:** 2026-08-27 · branch `master` · commit-base `c7b92a0`.
> **Natureza:** somente leitura/medição. **Nenhum** código-fonte, banco, migration, índice ou dependência foi alterado. Nenhum envio, worker real, provedor externo ou `.env` foi tocado.
> **Autoridade:** o código atual é a fonte da verdade. Onde a doc diverge do código, o código prevalece.

Complementa (não substitui):
- [`ai-handoff/13-PROBLEMAS-CONHECIDOS-E-DIVIDA-TECNICA.md`](ai-handoff/13-PROBLEMAS-CONHECIDOS-E-DIVIDA-TECNICA.md) — riscos de segurança/correção já catalogados.
- [`ai-handoff/16-MAPA-DE-ARQUIVOS-CRITICOS.md`](ai-handoff/16-MAPA-DE-ARQUIVOS-CRITICOS.md) — matriz de risco por arquivo.
- [`ai-handoff/18-ANTI-PADROES-E-ARMADILHAS.md`](ai-handoff/18-ANTI-PADROES-E-ARMADILHAS.md) — armadilhas que uma otimização não pode quebrar.
- [`ai-handoff/MAPA_BACKEND.md`](ai-handoff/MAPA_BACKEND.md) — índice de navegação rápido (criado nesta auditoria).

Esta auditoria acrescenta a dimensão de **desempenho/complexidade** que os docs acima marcavam como `NÃO CONFIRMADO` (sem `EXPLAIN`/telemetria). Toda recomendação abaixo é **estática** — validar com `EXPLAIN ANALYZE` e telemetria antes de refatorar.

---

## 1. Números do inventário

| Métrica | Valor |
|---|---:|
| Arquivos analisados (`.js` + `.sql`, excl. `node_modules`/`coverage`/`public`/`uploads`) | **520** |
| Código-fonte de aplicação (`.js`, excl. `tests`/`scripts`) | 223 arquivos · **77.081 linhas** |
| Testes (`tests/*.js`) | 106 arquivos |
| Scripts (`scripts/*.js`) | 22 arquivos |
| Migrations SQL | 116 |
| `controllers/` | 42 arquivos · ~31.470 linhas |
| `services/` | 76 arquivos · ~32.303 linhas |
| `helpers/` | 48 arquivos · ~6.996 linhas |
| `routes/` | 25 arquivos · ~1.922 linhas |
| `middleware/` | 16 arquivos · ~1.640 linhas |
| `repositories/` | 2 arquivos · 392 linhas |
| `workers/` | 1 arquivo · 567 linhas |

**Leitura:** dois arquivos (`chatController.js` + `aiDashboardService.js`) somam ~14.900 linhas — **19% de todo o código de aplicação** em 2 arquivos.

---

## 2. Os 15 maiores arquivos

| # | Arquivo | Linhas | Funções (aprox.) | Handlers/exports | Refs Supabase | `await` | Diagnóstico |
|--:|---|--:|--:|--:|--:|--:|---|
| 1 | `controllers/chatController.js` | **9.981** | ~265 | 64 | 230 | 407 | God object. Ver §4.1 |
| 2 | `services/aiDashboardService.js` | 4.882 | ~157 | 1 | 107 | 153 | Monólito coeso (IA read-only). Ver §4.5 |
| 3 | `controllers/webhookZapiController.js` | 4.410 | ~79 | 3 | 134 | 154 | `receberZapi` = 1 função de ~2.870 linhas. Ver §4.2 |
| 4 | `services/providers/ultramsg.js` | 2.368 | ~96 | 1 | 0 | 93 | Provider único; I/O externo + cache. Ver §4.4 |
| 5 | `controllers/dashboardController.js` | 1.965 | ~77 | 24 | 54 | 82 | Agregações analíticas. Ver §4.6 |
| 6 | `services/chatbotTriageService.js` | 1.879 | ~66 | 1 | 44 | 67 | Fluxo de triagem/bot no caminho inbound |
| 7 | `services/atendimentoSemRespostaService.js` | 1.463 | — | — | — | — | Scheduler 1 min + varredura |
| 8 | `controllers/disparoRevisaoController.js` | 1.441 | — | — | — | — | Módulo Disparo (em evolução) |
| 9 | `controllers/disparoLimitesController.js` | 1.202 | — | — | — | — | Módulo Disparo |
| 10 | `services/slaCalculationService.js` | 1.146 | — | — | — | — | Cálculo SLA (agregação) |
| 11 | `controllers/disparoExecucaoController.js` | 1.126 | — | — | — | — | Módulo Disparo |
| 12 | `services/supervisaoService.js` | 1.121 | — | — | — | — | Painel supervisão (agregação) |
| 13 | `helpers/conversationSync.js` | 1.119 | — | — | — | — | Localizar/criar/mesclar conversa (crítico) |
| 14 | `controllers/disparoVariacoesController.js` | 985 | — | — | — | — | Módulo Disparo + `readFileSync` |
| 15 | `services/oldMessagesSyncService.js` | 950 | — | — | — | — | Sync histórico via provider |

> **Regra respeitada:** tamanho ≠ ruim. `aiDashboardService.js` é grande porém coeso, isolado e read-only (baixo risco). O problema real é **concentração de responsabilidades por função**, não o número de linhas — ver §4.

---

## 3. Principais gargalos de desempenho (com evidência)

Classificação: **A** = evidência forte no código · **B** = provável, precisa de telemetria.

### 3.1 [A] Funções monolíticas no caminho quente
- `chatController.listarConversas` — **~1.570 linhas** (linhas 1469–3039). É o endpoint de listagem de conversas (a leitura mais frequente do app). Faz múltiplas queries sequenciais (conversas → prefs por usuário → counts → enriquecimento de contato → tags) e **pós-processamento pesado em memória**: `filter`/`sort`/`map`/dedup repetidos sobre o resultado (ex.: filtro defensivo de busca linhas 2829–2841, merge de prefs 2864–2888, reordenação por relevância 2897–2905).
- `webhookZapiController.receberZapi` — **~2.870 linhas** (linhas 1196–4067) numa **única função**. É o handler de **todo inbound**. Impossível de raciocinar sobre custo/alocação por caminho; closures internas (`updateStatusByWaId` 1373, `sendMessage` 2597) declaradas por requisição.
- **Impacto:** cada requisição aloca centenas de closures/objetos; difícil paralelizar com segurança; difícil instrumentar. Ganho de refatoração é **manutenção + previsibilidade de latência**, não necessariamente CPU.

### 3.2 [B] Queries sequenciais que poderiam ser concorrentes
- Padrão recorrente: `await` em série para dados independentes (prefs, tags, counts, enriquecimento) dentro de `listarConversas` e handlers de dashboard. **62** usos de `Promise.all` no código todo vs. **407 `await`** só em `chatController` — indício de sub-uso de concorrência onde é seguro.
- **Antes de otimizar:** confirmar independência real (sem dependência de dados) e que o Supabase/PostgREST aguenta o fan-out. Ganho: redução de latência p95 nos handlers de leitura.

### 3.3 [B] Filtragem/ordenação em memória
- **559** ocorrências de `.filter`/`.sort`/`.reduce` em `controllers/services/helpers/workers`. Parte é legítima (pós-processamento de página pequena), mas há filtros defensivos aplicados **após** trazer linhas do banco (ex.: `listarConversas` §3.1). Onde o volume por página é limitado, o custo é baixo; onde não há `.limit`/`.range`, é risco.
- `.limit(` aparece **170×** e `.range(` **40×** — cobertura de paginação existe, mas não é universal. **Ação:** inventariar as queries de coleção sem `limit`/`range` (grep dirigido) antes de assumir problema.

### 3.4 [A] `SELECT *` / over-fetch
- **47** `select('*')` em código de aplicação, incluindo caminhos quentes (`chatController`, `webhookZapiController`, `chatbotTriageService`, `helpDeskController`). `select('*')` traz colunas não usadas (inclui `jsonb`/`text` grandes como `payload`, `resultado_json`).
- **Ganho:** reduzir payload de rede Supabase→backend e memória. **Risco:** baixo, desde que se enumere exatamente as colunas usadas. **Validar** por teste de contrato do handler.

### 3.5 [A] Volume de logging síncrono
- **971** chamadas `console.*` no código de aplicação; `chatController` sozinho tem 146, `webhookZapiController` 93. Além disso, `middleware/logger.js` faz `console.log` em **todo** `res.finish` (uma linha por request), logando `req.originalUrl` sem redigir.
- **Impacto duplo:** (1) `console.*` é síncrono e serializa via stdout — sob carga, contribui para latência; (2) **segurança já catalogada** — JWT em query string (`/media/proxy`) vai para o log (ver 13-PROBLEMAS §logger e 18-ANTI-PADROES #11).
- **Ganho:** logger estruturado com níveis (silenciar debug em prod) + redação de query. Baixo risco, ganho de I/O e segurança.

### 3.6 [A] Caches/timers em memória sem coordenação
- **166** `new Map()/new Set()` como estado de processo. Exemplos com timer de limpeza próprio: dedup de client_temp_id (`chatController` L121–127, TTL 30s / limpeza 5min), cache do provider (`ultramsg.js` L1678), rate limiter operacional (`operationalRateLimiter.js`, `Map` por empresa **sem expiração** — cresce com nº de empresas até restart).
- **14 `setInterval`** vs **5 `clearInterval`** — nem todos os timers têm limpeza no shutdown (a maioria usa `.unref()`, o que evita segurar o processo, mas não é o mesmo que teardown determinístico — contribui para o "Jest não encerra limpo").
- **Impacto:** estado perdido no restart; **não escala horizontalmente** (PM2 `instances: 1` — ver 18-ANTI-PADROES #13). `operationalRateLimiter` `Map` sem expiração é um leak lento (bounded pelo nº de empresas, então baixo, mas real).

### 3.7 [B] Worker de fila com throughput limitado
- `queueManager.startWorker` faz poll a cada 5s e busca **1** job por ciclo (`limit(1)` em `getNextPendingJob`), mesmo com `MAX_CONCURRENT=2`. Efetivamente ~1 job/5s de admissão. Para syncs longos (contatos/fotos/mensagens antigas) é aceitável; para picos de fila, é serial.
- **Ganho:** buscar lote = `MAX_CONCURRENT` por ciclo. **Risco:** médio — precisa manter o lock otimista atual (`update ... eq(status,'pending')`) por item e não quebrar `recoverStaleRunningJobs`.

### 3.8 [B] Migrations de índice — cobertura a validar
- 116 migrations, **59** com `CREATE INDEX` (244 índices declarados no total). Em `mensagens`/`conversas` há ~6 índices citados. Não há como provar cobertura sem `EXPLAIN`. **Não criar índice às cegas.** Ação: coletar as 5 queries mais frequentes (listagem de conversas, busca de mensagens por conversa, dedup por `whatsapp_id`, unread por usuário, dashboard por período) e rodar `EXPLAIN ANALYZE` em ambiente seguro.

---

## 4. Análise por arquivo crítico e como dividir

### 4.1 `controllers/chatController.js` (9.981 linhas · 64 handlers) — **PRIORIDADE 1**
Concentra: listagem, detalhe, envio (texto/arquivo/pix/contato/localização/ligação/reação), atendimento (assumir/encerrar/reabrir/transferir), tags, notas internas, merge de duplicatas, sync de contatos/fotos, reenvio, encaminhamento. 80 `require` no topo — acoplamento altíssimo.

Handlers gigantes: `listarConversas` (~1.570), `enviarArquivo` (~683), `enviarMensagemChat` (~524), `detalharChat` (~365).

**Divisão futura sugerida (sem implementar agora):**
- `controllers/chat/listController.js` — `listarConversas`, `contarConversasPorFiltros`, `buscarMensagensConversa`.
- `controllers/chat/sendController.js` — `enviarMensagemChat`, `enviarArquivo`, `enviarReacao`, `enviarContato`, `enviarLocalizacao`, `enviarLigacao`, `enviarMensagemPix`, reenvios, encaminhar.
- `controllers/chat/atendimentoController.js` — assumir/encerrar/reabrir/transferir/puxar fila/atendentes.
- `controllers/chat/contatoController.js` — vincular cliente, nome, observação, criar contato, prefs.
- `controllers/chat/tagsNotasController.js` — tags e notas internas.
- **Extrair regra de negócio para services**: a lógica de montagem de query/enriquecimento de `listarConversas` → `services/chatListService.js` (parte já existe em `chatListCountsService`/`conversaEnrichment`). Emissão socket → helper único.
- **Risco:** ALTO (muitas suites `chat*` dependem dos exports). Fazer por extração incremental mantendo `chatController.js` como fachada que re-exporta, com testes verdes a cada passo.

### 4.2 `controllers/webhookZapiController.js` (4.410 linhas) — **PRIORIDADE 2**
`receberZapi` (~2.870 linhas) e `statusZapi` (ACK, ~330 linhas). Caminho inbound/ACK ativo (nome legado — **não remover**).

**Divisão sugerida:**
- `handlers/inbound/` separando por tipo de payload: mensagem de texto, mídia, grupo, fromMe/reconciliação, status/ACK.
- Extrair para services já existentes: dedup por `whatsapp_id` → um `inboundDedupeService`; reabertura → `services/conversa*`; mídia → já em `inboundMediaPersistenceService`.
- **Contrato inquebrável:** dedup por `whatsapp_id` **antes** de qualquer side effect (chatbot/reabertura/socket) — 18-ANTI-PADROES #7. Ordem de status unidirecional (#3).
- **Risco:** ALTO. Suites de webhook (`webhookZapiPure`, ACK, fromMe, disparoUltramsgReferenceId).

### 4.3 `helpers/conversationSync.js` (1.119 linhas) — crítico, não urgente
Localiza/cria/mescla conversa por telefone+instância+tenant. Baixo volume de linhas por função, mas **altíssimo risco** (matching de tenant). Não dividir sem necessidade; qualquer mudança exige `conversasOpenUniqueMultiInstance` verde.

### 4.4 `services/providers/ultramsg.js` (2.368 linhas) — I/O externo
Único provider. Sem refs Supabase (bom isolamento). Contém cache com `setInterval` de limpeza. **Ação de perf:** garantir `timeout`/cancelamento em toda chamada externa (verificar) e backoff. **Divisão:** por família de endpoint (envio, chats/mensagens, grupos, contatos, instância). Risco MÉDIO (mock em todas as suites; preservar `referenceId` e mascaramento de token).

### 4.5 `services/aiDashboardService.js` (4.882 linhas) — **grande mas baixo risco**
Read-only, isolado (usado só por `aiController`), 1 export. Bom candidato a **split cosmético** por coesão: `ai/intents.js`, `ai/lexicons.js`, `ai/executors.js`, `ai/schema.js`. **Ganho de perf ~nulo**; ganho de legibilidade/IA alto. **Não é urgente.**

### 4.6 `controllers/dashboardController.js` + `services/slaCalculationService.js` + `services/supervisaoService.js`
Agregações analíticas por período. Candidatos a: (a) enumerar colunas (evitar `select('*')`), (b) empurrar agregação para SQL/RPC quando hoje é feita em JS, (c) cache curto por empresa+período. **Validar com `EXPLAIN` primeiro** — pode já haver índice adequado.

---

## 5. Fluxos críticos — regras que uma otimização NÃO pode quebrar

Reafirmando o que 18-ANTI-PADROES já normatiza, na ótica de performance:

1. **Inbound:** dedup por `whatsapp_id` **antes** de side effects. Não "paralelizar" chatbot/reabertura/socket para frente da deduplicação.
2. **Status de mensagem:** `pending → sent → delivered → read` unidirecional. ACK fora de ordem ignorado se já está à frente. Não introduzir cache que reintroduza status antigo.
3. **Outbound não é atômico:** `client_temp_id`/`referenceId` para idempotência. Nunca retry cego. O reconciliador (`pendingOutboundReconciliationService`) é a rede de segurança — não remover ao refatorar envio.
4. **Multi-tenant:** `company_id` sempre do JWT; toda query filtra `company_id`. Qualquer extração de query para service **carrega o filtro junto**. `SERVICE_ROLE` ignora RLS.
5. **Socket:** listeners só no boot (`index.js`/`socket/`). Nunca dentro de handler. Emitir na sala mínima (evitar broadcast `empresa_<id>` para eventos de conversa/setor — 13-PROBLEMAS §broadcasts).
6. **`io` vem de `req.app.get('io')`** — falha de emit não pode virar 500 pós-persistência (18-ANTI-PADROES #16).
7. **Estado em memória** (dedup, rate limit, presença, schedulers) **não** pode virar premissa de correção enquanto `instances: 1` e sem Redis.

---

## 6. Banco de dados (somente por código/migrations)

- **Fonte do schema:** `supabase/migrations/` ordenadas por timestamp. `schema.sql` é contextual (pode divergir).
- **Queries mais frequentes (inferidas):** listagem de conversas (`listarConversas`), mensagens por conversa (`buscarMensagensConversa`), dedup inbound por `whatsapp_id`, unread por usuário (`conversa_unreads`), agregações de dashboard/SLA por período.
- **Índices:** 244 declarados em 59 migrations; ~6 tocam `mensagens`/`conversas`. **Cobertura não provável sem `EXPLAIN`.**
- **Isolamento:** dependente 100% de filtro `company_id` no app-layer.
- **Como validar depois (ambiente seguro, read-only):** capturar SQL real das 5 queries acima (log do PostgREST ou reconstrução), rodar `EXPLAIN (ANALYZE, BUFFERS)`; procurar `Seq Scan` em tabelas grandes filtradas por `company_id`/`conversa_id`/`whatsapp_id`. **Não aplicar índice sem esse passo.**

---

## 7. Organização e acoplamento

- **Controllers com regra de negócio:** `chatController`, `webhookZapiController`, `dashboardController` misturam HTTP + regra + persistência. Direção: empurrar regra para `services/`.
- **`repositories/` subutilizado:** só 2 arquivos (chat interno). O resto acessa `supabase` direto em controllers/services (230 refs só no `chatController`). Uma camada de repositório por domínio reduziria `select('*')` e centralizaria filtros `company_id`.
- **Config espalhada:** flags via `process.env` lidas em vários pontos (`PROTECAO_DESATIVADA`, gates de Disparo, `AI_MODEL`, limites de fila). `config/env.js` + `helpers/featureFlags.js` existem — consolidar leituras dispersas ali.
- **Nomes legados que enganam:** `webhookZapiController`, `empresa_zapi`, evento `zapi_sync_contatos` — **ativos**, não remover (18-ANTI-PADROES #1).
- **Arquivos "mortos"/shim:** `controllers/webhookController.js` (shim 410, não montado). Ver §"Não existe mais" no CLAUDE.md.

---

## 8. Testes e segurança da refatoração

- **Suíte:** 106 arquivos de teste (Jest + supertest, `--runInBand`). `tests/setup.js` **mocka o Supabase** — testes **não** exercitam SQL/RLS real (18-ANTI-PADROES #10).
- **Cobertura por área crítica:** webhook (`webhookZapiPure`, ACK, fromMe), instâncias (`whatsappInstanceService`, `ultramsgProviderInstanceResolution`), disparo (`disparoVariacoes`, `disparoInstancias`, `disparoDestinatarios`, `disparoLimites`), mídia inbound (`inboundMediaPersistence`), helpdesk, old messages/search.
- **Lacunas conhecidas (13-PROBLEMAS):** `disparoRevisao.test.js` não exercita o caminho de sucesso do export; Jest não encerra limpo (handle aberto — timers §3.6).
- **Antes de otimizar cada área, rodar:**

  | Área a mexer | Suites a rodar antes |
  |---|---|
  | `chatController` (lista/envio) | `chat*`, `mensagem*`, mídia, `conversas*` |
  | `webhookZapiController` | `webhookZapiPure`, ACK, fromMe, `disparoUltramsgReferenceId` |
  | provider `ultramsg` | `ultramsgProviderInstanceResolution`, `whatsappInstanceService` |
  | `conversationSync` | `conversasOpenUniqueMultiInstance`, operational phase |
  | fila/worker | `queueManager`/jobs + smoke manual dois-tenant |
  | disparo | suítes `disparo*` completas |

- **Comando seguro de validação:** `ZAPERP_DISABLE_BACKGROUND_JOBS=true npx jest --runInBand` (não sobe schedulers/worker; usa mock do Supabase).
- **Regra de ouro:** toda query nova/movida exige teste negativo empresa A × ID empresa B.

---

## 9. Ranking final de otimização

### 9.1 Ganho rápido, baixo risco (fazer primeiro)

| Ordem | Arquivo/alvo | Motivo | Ganho esperado | Esforço | Risco | Testes prévios |
|--:|---|---|---|---|---|---|
| 1 | `middleware/logger.js` + `console.*` em prod | Log síncrono em todo request + JWT em query no log | I/O + segurança | Baixo | Baixo | smoke `/health`, auth |
| 2 | `select('*')` nos caminhos quentes (`chatController`, `webhookZapiController`, `chatbotTriageService`) | Over-fetch de colunas/`jsonb` | Rede+memória Supabase | Baixo-Médio | Baixo | contrato dos handlers |
| 3 | `operationalRateLimiter` `Map` sem expiração + teardown de timers | Leak lento + Jest não encerra | Memória/estabilidade CI | Baixo | Baixo | `queueManager`/jobs |
| 4 | `queueManager.getNextPendingJob` (lote = `MAX_CONCURRENT`) | Admissão serial de fila | Throughput de sync | Baixo-Médio | Médio | jobs + dois-tenant |

### 9.2 Ganho médio

| Ordem | Arquivo/alvo | Motivo | Ganho | Esforço | Risco | Testes prévios |
|--:|---|---|---|---|---|---|
| 5 | Queries sequenciais → `Promise.all` onde independentes (`listarConversas`, dashboard) | Latência p95 leitura | Latência | Médio | Médio | `chat*`, dashboard |
| 6 | Agregações JS → SQL/RPC + cache curto (`dashboardController`, `slaCalculationService`, `supervisaoService`) | CPU/latência analítica | Latência dashboard | Médio | Médio | dashboard/SLA/supervisão |
| 7 | Split coeso `aiDashboardService.js` | Legibilidade/IA (não perf) | Manutenção | Médio | Baixo | `aiController` |

### 9.3 Núcleo crítico, alto risco (planejar, não improvisar)

| Ordem | Arquivo/alvo | Motivo | Ganho | Esforço | Risco | Testes prévios |
|--:|---|---|---|---|---|---|
| 8 | `chatController.js` — extração incremental por domínio | God object 9.981 linhas | Manutenção + latência previsível | Alto | **Alto** | todas `chat*` + mídia |
| 9 | `webhookZapiController.receberZapi` — quebrar em handlers por tipo | Função de ~2.870 linhas no caminho inbound | Manutenção + observabilidade | Alto | **Alto** | webhook/ACK/fromMe |
| 10 | `provider/ultramsg.js` — timeout/cancelamento + split por família | Resiliência a I/O externo | Estabilidade | Médio-Alto | Médio | provider/instância |

### 9.4 Não precisam ser alterados agora
- `helpers/conversationSync.js`, `helpers/phoneHelper.js` — críticos, corretos, baixo custo por chamada. Mexer só com necessidade funcional.
- Migrations/índices — **não** criar sem `EXPLAIN`.
- Módulo Disparo (`disparo*`) — em evolução e com worker gated; auditar quando estabilizar (etapa 9 pendente de migration).
- `schema.sql`, shim `webhookController.js` — não tocar.

---

## 10. Testes e verificações executados nesta auditoria

- Inventário estático (contagem de arquivos/linhas/funções/refs) — OK.
- Greps dirigidos de padrões de perf (`select('*')`, `setInterval`/`clearInterval`, caches, `Promise.all`, `console.*`, `.limit`/`.range`) — OK.
- Leitura direcionada de `index.js`, `app.js`, `queueManager.js`, `logger.js`, `operationalRateLimiter.js` e amostras de `chatController`/`webhookZapiController` — OK.
- **Suíte Jest:** executada com `ZAPERP_DISABLE_BACKGROUND_JOBS=true npx jest --runInBand`. **Resultado registrado em §10.1.**

### 10.1 Resultado da suíte

```
Test Suites: 105 passed, 105 total
Tests:       1095 passed, 1095 total
Snapshots:   0 total
Time:        ~180 s
```
**Exit code 0. Todos os testes passam.** Porém: `Jest did not exit one second after the test run has completed` — **handle assíncrono aberto** confirmado (timer/socket/pool não encerrado), coerente com §3.6 e 13-PROBLEMAS. Diagnosticar com `--detectOpenHandles` (não desabilitar a detecção).

**Bloqueios conhecidos (não reproduzidos como falha, apenas ambientais):**
- Testes usam **mock** do Supabase — não validam RLS/SQL real nem isolamento de tenant no banco.
- Jest historicamente **não encerra limpo** (handle aberto) — ver 13-PROBLEMAS. Rodar com `--detectOpenHandles` para diagnosticar timer/socket não fechado.

---

## 11. Confirmação de não-alteração

Nesta auditoria **não** houve: edição de código-fonte, alteração de banco/migrations/índices/RPC, mudança de dependências (`npm`), `npm audit fix`, execução de worker/fila/scheduler em modo real, envio de WhatsApp, chamada a provedor externo, leitura/exposição de segredos do `.env`, commit ou push. Os únicos arquivos criados são esta auditoria e [`ai-handoff/MAPA_BACKEND.md`](ai-handoff/MAPA_BACKEND.md).
