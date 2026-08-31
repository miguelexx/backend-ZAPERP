# 22 — Assistente IA do dashboard: mapa para modularização

> Criado: **2026-08-31**. Atualizado: **2026-08-31** (Sessão A executada).  
> Fonte original: `services/aiDashboardService.js` (~4.883 linhas).  
> Estados: **CONFIRMADO** = código; **INFERÊNCIA**; **PENDENTE** = OpenAI/VPS real.

Arquivo-alvo: [`services/aiDashboardService.js`](../../services/aiDashboardService.js)  
Único export: `answerDashboardQuestion`.  
HTTP: `POST /ai/ask` → [`controllers/aiController.js`](../../controllers/aiController.js) → este service.  
Rotas: [`routes/aiRoutes.js`](../../routes/aiRoutes.js) — `auth` + `supervisorOrAdmin` + `aiLimiter`.

**Não confundir** com [`controllers/dashboard/`](../../controllers/dashboard/) (KPIs HTTP do painel, doc [20](20-DASHBOARD-MODULARIZACAO.md)). Este service é o assistente em linguagem natural.

Comentário no topo cita “Z-API sync” para nomes — **CONFIRMADO** errado; nomes vêm de UltraMSG/webhook (`helpers/contactEnrichment.js`). A IA **não** grava `clientes.nome`.

---

## 1. O que o arquivo faz

Pipeline **CONFIRMADO**:

1. Classifica a pergunta em um **intent da allowlist Zod** (1ª chamada OpenAI, `temperature: 0`).
2. Ajusta intent/entidades com heurísticas determinísticas (roda **duas vezes**, em volta dos enrichers).
3. Calcula período (body `period_days` vs parser `America/Sao_Paulo` vs default por intent).
4. Executa **uma query pré-definida** no Supabase (SERVICE_ROLE) — **nunca SQL livre**.
5. Anexa `resumo_operacional_ia` + `analitica_ui`.
6. Gera texto (2ª chamada OpenAI).
7. Sanea contradições (métricas, evidências, “hoje”, contagens).

`UNKNOWN` vira `GENERAL_CHAT` **antes** do `switch` — pergunta ilegível ainda recebe KPIs agregados, não erro.

Controller (fora deste arquivo): flag `ia_config.config.ia.usar_ia`, cota `ai_logs`, cache `ai_cache` 24h, dedupe in-flight, auditoria. Bypass de cache para ranking/CSV/busca.

---

## 2. Mapa por linhas (monolito **original**, pré-Sessão A)

Os números abaixo descrevem o arquivo **antes** de extrair `services/aiDashboard/`. No service atual, `classifyQuestion` começa por volta da linha 69; as `q*` e o `switch` continuam neste arquivo. Para o que já saiu, use a §8.

| Bloco | Linhas | Assunto | Candidato |
|-------|--------|---------|-----------|
| Config, usage, compactação de prompt | 25–100 | `AI_MODEL`, `clampDays`, tokens, truncagem | `constants.js` + `promptPayload.js` |
| `IntentSchema` Zod (30 valores) | 102–152 | allowlist | `intentSchema.js` |
| Léxicos + busca textual | 154–251 | promoção/financeiro/compra/operacional/cordial | `lexicos.js` + `searchText.js` |
| `classifyQuestion` | 253–317 | prompt + parse JSON + Zod | `classify.js` |
| Saneadores pré-format + `formatAnswer` | 319–502 | prompts por família de intent | `formatAnswer.js` + `sanitizers.js` |
| 1ª resposta, paginação, cordialidade | 504–564 | `buildMsgsByConv`, `fetchMensagensPaged` | `firstResponse.js` |
| Queries KPI / SLA / notas | 566–1225 | overview, speed, top, SLA, `qGlobalContext` | `queries/metrics.js` |
| Tempo SP + heurísticas + resolve nome | 1227–1834 | `RECORTE_TZ`, `resolveTemporalAnalyticsScope` | `time.js` + `heuristics.js` + `resolveEntities.js` |
| Queries analíticas | 1836–2776 | busca, chat interno, rankings, CSV | `queries/search.js` + `queries/rankings.js` + `queries/reports.js` |
| Histórico / transferências / autor | 2778–3822 | maior bloco; `qDetalhesConversa` = histórico cliente | `queries/history.js` |
| Resumo operacional + UI + orquestrador | 3824–4880 | `attachResumo*`, switch de intents | `resumoOperacional.js` + `analiticaUi.js` + `orchestrator.js` |
| Export | 4882 | `{ answerDashboardQuestion }` | `index.js` + shim |

---

## 3. Intents (allowlist — não encolher nem inventar)

Classificador + `switch` devem permanecer alinhados. Aliases **CONFIRMADOS**:

| Intent | Query | Nota |
|--------|--------|------|
| `METRICS_OVERVIEW` | `qMetricsOverview` | “Hoje” = meia-noite **local do processo**, não `America/Sao_Paulo` |
| `ATENDENTE_MAIS_RAPIDO` / `_LENTO` | `qAtendenteSpeed` ASC/DESC | |
| `TEMPO_MEDIO_ATENDENTE` | `qTempoMedioRespostaAtendente` | exige nome |
| `ANALISE_TOM_ATENDENTE` | `qAmostraTextosAtendente` | |
| `TOP_ATENDENTES_POR_CONVERSAS` | `qTopAtendentesPorConversas` | |
| `CLIENTES_MAIS_ATIVOS` | `qClientesMaisAtivos` | `direcao=in` |
| `SLA_ALERTAS` | `qSlaAlertas` | |
| `GENERAL_CHAT` | `qGlobalContext` | overview + top + ativos + SLA + notas em paralelo |
| `MENSAGENS_USUARIO_CLIENTE` | `qMensagensUsuarioCliente` | até 200 msgs |
| `CONVERSAS_USUARIO_CLIENTE` | chama a anterior + `resumo` | |
| `HISTORICO_CLIENTE` | `qHistoricoCliente` | exclui grupos/`@g.us` |
| `DETALHES_CONVERSA` | **igual** `qHistoricoCliente` | não há lookup por id de conversa |
| `HISTORICO_ATENDENTE` | `qHistoricoAtendente` | |
| `RELATORIO_ATENDENTE_COMPLETO` | histórico + tempo + amostra | para se nome ambíguo |
| `RANKING_TEMPO_RESPOSTA_ATENDENTES` | `qRankingTempoRespostaAtendentes` | |
| `BUSCA_CONTEUDO_MENSAGENS` | `qBuscaConteudoMensagens` | default 365 dias se sem período |
| `CHAT_INTERNO_POR_TEMA` | `qChatInternoPorTema` | `internal_messages` |
| `CLIENTES_POR_TEMA_FINANCEIRO` | léxico financeiro se termos vazios | |
| `CONVERSAS_POR_ASSUNTO_OPERACIONAL` | léxico operacional | |
| `ATENDENTE_MAIS_MENSAGENS_COM_TEMA` | outbound + termos | |
| `RANKING_EDUCACAO_ATENDENTES` | heurística léxico cordial | **não** é nota do cliente |
| `QUALIDADE_ATENDIMENTOS_RANKING` | `avaliacoes_atendimento` | tabela pode faltar (try/warn) |
| `SINAIS_INTERESSE_COMPRA` | **wrapper** de busca + léxico comercial | |
| `ATENDIMENTOS_LINGUAGEM_PROBLEMA` | notas ≤4 + texto | |
| `ATENDIMENTOS_TRANSFERIDOS` | `atendimentos` ação transferiu | |
| `CLIENTES_MENSAGEM_SEM_RESPOSTA_ATENDENTE` | in sem out do autor no recorte | **não** é o job `atendimentoSemResposta` |
| `MENSAGENS_ENVIADAS_ATENDENTE_AUTOR` | `autor_usuario_id` | |
| `RELATORIO_PRODUTIVIDADE_ATENDENTES` | CSV em `csv_artifacts`; default 30d | heurística na pergunta força este intent |
| `UNKNOWN` | não entra no switch | vira `GENERAL_CHAT` |

---

## 4. Invariantes (não regressar)

1. **Só SELECT.** Sem `update`/`insert` em clientes, conversas, mensagens. Nomes: só UltraMSG/webhook.
2. **Sem SQL livre.** Intent fora do Zod → `UNKNOWN` → `GENERAL_CHAT`. Não aceitar query do modelo.
3. **`company_id` só do caller autenticado** (JWT no controller). Toda query de negócio filtra tenant. `historico_atendimentos` às vezes filtra só `conversa_id` **já** obtido de `conversas.eq(company_id)` — não soltar esse encadeamento.
4. Lookups `usuarios`/`clientes` por `id` depois de `resolve*Candidates(..., company_id)` — não buscar nome sem tenant.
5. **Dois passos OpenAI** (classificar + formatar). Saneadores **depois** do texto, nesta ordem: contradição de métricas → negação com evidência → linguagem temporal → contagens.
6. Heurísticas **duas vezes** em volta de `enrichDataReferenciaFromQuestion` / `enrichTermosBuscaFromIntent`.
7. Período: body explícito vs “hoje/ontem/semana/mês” em SP vs default 7 / 30 (produtividade) / 365 (buscas amplas). Histórico de atendente **ignora** `period_days=1` do body se a pergunta **não** fixou o dia (`ignorarPeriodBodyPadrao`).
8. `qMetricsOverview.taxaConversao` = fechadas/total de conversas **neste** payload. **Não** é `kpis.taxa_conversao_percent` do dashboard HTTP (CRM legado, sempre `null`).
9. “Hoje” do overview usa `setHours(0,0,0,0)` do **servidor**. Recorte de mensagens usa `America/Sao_Paulo`. **Não unificar** na quebra — muda KPI.
10. Grupos fora de histórico de cliente (`filtrarConversasIndividuais`).
11. Ambiguidade de nome: não escolhe um id; devolve candidatos e a IA deve confessar.
12. Export público **somente** `answerDashboardQuestion`. Cache/cota ficam no controller.
13. `fetchMensagensPaged`: page 2000, teto 30000. Não “otimizar” o teto sem medir.
14. Falha de `avaliacoes_atendimento` inexistente: warn + payload vazio, não crash.
15. Não chamar OpenAI real / não gastar cota de produção sem autorização.

---

## 5. Tabelas tocadas (leitura)

`empresas`, `atendimentos`, `conversas`, `mensagens`, `usuarios`, `clientes`, `avaliacoes_atendimento`, `historico_atendimentos`, `internal_messages`, `internal_conversation_participants`.

Controller: `ia_config`, `ai_cache`, `ai_logs`, `empresas.ai_limit_per_month`.

Migrations: `20250227000001_ai_tables.sql` (+ RLS em `20260630120000_rls_company_id_hardening.sql`). SERVICE_ROLE ignora RLS — filtro app-layer obrigatório.

---

## 6. Env

| Variável | Onde | Default |
|----------|------|---------|
| `AI_MODEL` | service | `gpt-4o-mini` |
| `AI_PROMPT_MAX_CHARS` | compactação JSON | 28000 (8k–60k) |
| `OPENAI_API_KEY` | `openaiClient` (lazy, timeout 30s, 0 retries) | obrigatória para o endpoint |
| `AI_MONTHLY_DEFAULT_LIMIT` | controller | 300 |
| `AI_RATE_LIMIT_MAX` | rotas | 120/min por `company_id` |

---

## 7. Testes

**Sessão A (2026-08-31):** `tests/aiDashboardSessionA.test.js` — 35 testes, só módulos puros (sem OpenAI, sem queries).  
**Ainda sem teste:** `classifyQuestion`, `formatAnswer`, `q*`, `answerDashboardQuestion`, `POST /ai/ask`.

Antes da Sessão B (queries), a suite da Sessão A precisa continuar verde (os itens abaixo já estão nela).

- `clampDays`, `normalizeOpenAiUsage` / `addUsage`
- `expandTermosForSearch`, `textoCasaTermoRobusto`, `sanitizeIlikeTerm`
- `filtrarConversasIndividuais`
- `calcFirstResponseDiff` / `buildMsgsByConv`
- `aplicarHeuristicasDeterministicas` (produtividade vs busca)
- `IntentSchema.safeParse` (intent inválido → fail)
- saneadores com fixtures de `answer` + `data`

Orquestrador e queries: mock `openai` + `supabase` **depois**. Não usar chave real.

---

## 8. Estrutura

**Sessão A (CONFIRMADO no disco):** o service **não** é shim. Continua com classify, format, queries, resumo e orquestrador. Importa de `./aiDashboard/*.js`.

```
services/aiDashboardService.js          ← ainda contém q* + classify + format + switch
services/aiDashboard/
  constants.js          ✓
  intentSchema.js       ✓
  lexicos.js            ✓
  searchText.js         ✓
  promptPayload.js      ✓
  time.js               ✓
  firstResponse.js      ✓
  heuristics.js         ✓
  sanitizers.js         ✓
  resolveEntities.js    ✓  (I/O Supabase; corpo idêntico ao HEAD)
  classify.js           pendente Sessão B
  formatAnswer.js       pendente Sessão B
  queries/*.js          pendente Sessão B
  resumoOperacional.js  pendente Sessão B
  analiticaUi.js        pendente Sessão B
  orchestrator.js       pendente Sessão B
  index.js              só no shim final
```

Na extração, 54 funções foram conferidas contra o monolito então versionado (0 diffs de corpo). Heurística **duas vezes** e `UNKNOWN` → `GENERAL_CHAT` permanecem no orquestrador do service.

Shim **explícito** no final: `require('./aiDashboard/index.js')`.

Não fundir `queries/metrics.js` com `controllers/dashboard/`. Não fundir “sem resposta” da IA com `atendimentoSemResposta/`.

---

## 9. Fases

Cada fase: fachada estável, **sem** OpenAI real. Sem migration, sem Socket.

| Fase | O quê | Risco | Gate |
|------|--------|-------|------|
| **0** | Este documento | n/a | feito |
| **1–3 (Sessão A)** | Puras + schema/léxicos/heurísticas + tempo SP + resolve + saneadores | baixo/médio | **feito** — 35 testes em `aiDashboardSessionA.test.js` |
| **4** | Mover queries **bit a bit** (metrics → search → history por último) | **muito alto** | mocks Supabase; não alterar filtros |
| **5** | `classify` + `formatAnswer` (saneadores já saíram na A) | alto (prompts) | snapshot dos system prompts |
| **6** | `orchestrator` + shim | alto | 1 teste de `switch` com deps mockadas |

Sessão B = fases 4–6, **só** com a suite A verde. Não “corrigir” timezone do overview. Não apagar wrappers (`qSinaisInteresseCompra`, `qDetalhesConversa`, `qConversasUsuarioCliente`).

---

## 10. Dívida (não “consertar” no split)

| Item | Estado |
|------|--------|
| Queries / classify / `/ai/ask` sem teste | CONFIRMADO (Sessão A cobriu só puros) |
| Overview “hoje” ≠ fuso SP das mensagens | CONFIRMADO |
| `totalConversas` limitado a 5000 linhas | CONFIRMADO — subcontagem em tenant grande |
| `qDetalhesConversa` não aceita `conversa_id` | CONFIRMADO |
| Ranking “educação” ≠ avaliação do cliente | fácil de misturar na UI |
| Comentário Z-API no header | legado; não reintroduzir sync de nome |
| Dois round-trips OpenAI + JSON grande | custo/latência; truncagem já existe |
| `historico_atendimentos` sem `.eq('company_id')` direto | INFERÊNCIA segura se ids vierem de conversas do tenant |

---

## 11. Como testar

```text
NODE_ENV=test ZAPERP_DISABLE_BACKGROUND_JOBS=1 npx jest tests/aiDashboardSessionA.test.js --runInBand
```

Nunca `OPENAI_API_KEY` de produção. Nunca `POST /ai/ask` contra empresa real sem autorização.

Manual (homologação, depois da quebra): overview; “hoje” vs “ontem”; busca por tema; nome ambíguo de atendente; CSV produtividade; empresa com `usar_ia=false` → 403 no controller.
