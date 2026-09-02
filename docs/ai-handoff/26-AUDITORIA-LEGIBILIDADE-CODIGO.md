# 26 — Auditoria de legibilidade de código (para IA)

> Feita **2026-09-01**. Pergunta: *"um AI consegue entender o que cada arquivo/função faz sem ler tudo?"*
> Método: contagem de LOC, blocos `/**`, funções exportadas e header de topo em 322 arquivos
> (`controllers`, `services`, `helpers`, `routes`, `middleware`, `workers`, `validators`, `config`, `socket`, `repositories`).
> Complementa: `DOCUMENTATION_AUDIT.md` (inventário de **docs**) e [25](25-AUDITORIA-PROXIMOS-ALVOS.md) (alvos de **modularização**).

## Veredito

- **Documentação de SISTEMA** (docs/ai-handoff 00–25, `AI_HANDOFF.md`, `DOCUMENTATION_AUDIT.md`, mapa [16](16-MAPA-DE-ARQUIVOS-CRITICOS.md)): **forte e atual** — conhece a estrutura modular nova (`webhookInbound/`, `chat/`, `dashboard/`, `aiDashboard/`), tem tabelas "não procurar" corretas. Nada crítico aqui.
- **Legibilidade de CÓDIGO**: **boa** nos arquivos críticos e já modularizados (headers + JSDoc razoáveis); **fraca** nos god-objects ainda não modularizados. O pior ofensor por volume é o **cluster DISPARO**.

Ou seja: um AI entende a *arquitetura* rápido pelos docs, mas para *mexer* nos god-objects abaixo ainda precisa ler centenas de linhas por falta de JSDoc/header.

---

## Achados priorizados

### P0 — Cluster DISPARO sem mapa de CÓDIGO
~11.5k linhas, **21 arquivos** (`controllers/disparo*.js` 10 arqs/7.748 L + `services/disparo*.js` 11 arqs/3.782 L), quase sem JSDoc. Só há docs de **produto/runbook** (`DISPARO_MENSAGENS.md`, `DISPARO_GO_LIVE_RUNBOOK.md`, …) — **nenhum mapa de código** (quem chama quem, fila→worker→send→reconcile, os "três gates", anti-reenvio incerto). Piores:

| Arquivo | LOC | JSDoc | ~fns |
|---|---|---|---|
| `controllers/disparoRevisaoController.js` | 1.512 | **1** | 46 |
| `controllers/disparoLimitesController.js` | 1.201 | 2 | 21 |
| `controllers/disparoExecucaoController.js` | 1.175 | **1** | 17 |
| `controllers/disparoEtapa8Controller.js` | 638 | 1 | 13 |
| `services/disparoFilaService.js` | 641 | 4 | 23 |

→ ✅ **FEITO (2026-09-01):** [`27-DISPARO-MAPA.md`](27-DISPARO-MAPA.md) — fluxo worker→fila→send→hook, gates, lease, 18 tabelas, índice por Etapa. (Não modularizado — o problema era **mapa**, não tamanho.)

### P0 — Confusão de nomes: `aiController` × `iaController`
Dois controllers quase homógrafos, papéis **diferentes** — armadilha clássica de pegar o errado:
- [`controllers/aiController.js`](../../controllers/aiController.js) → `POST /api/ai/ask` — assistente de linguagem natural do dashboard (bem documentado). Serviço: `aiDashboardService`. Mapa: [22](22-AI-DASHBOARD-MODULARIZACAO.md).
- [`controllers/iaController.js`](../../controllers/iaController.js) → `/ia/config`, `/ia/regras` — **config do chatbot/URA de triagem** (sem header). Serviço: `chatbotTriageService`.

→ ✅ **FEITO (2026-09-01):** header de desambiguação em `aiController.js` **e** `iaController.js` ("NÃO confundir com o outro", papel e serviço de cada). Renomear (`iaController`→`chatbotConfigController`) fica adiado (mexe em rota/import — só com plano).

### P1 — God-objects com ~0 JSDoc **e** sem header de topo
Um AI abre estes e não tem nenhuma orientação (nem 1 linha de "o que é este arquivo"):

| Arquivo | LOC | JSDoc | Header |
|---|---|---|---|
| `controllers/whatsappIntegrationController.js` | 786 | **0** | ❌ |
| `controllers/helpDeskController.js` | 771 | **0** | ❌ |
| `services/oldMessagesSyncService.js` | 951 | 1 | ❌ |
| `services/chatListCountsService.js` | 798 | 3 | ❌ |
| `services/slaCalculationService.js` | 1.147 | 4 | ✔ (mas 45 fns) |
| `services/absenceFinalizationService.js` | 886 | 8 | ❌ |

→ ✅ **FEITO (2026-09-01):** header (papel, entradas, invariantes) adicionado em `whatsappIntegrationController`, `helpDeskController`, `oldMessagesSyncService`, `chatListCountsService`, `absenceFinalizationService`. Restam JSDoc por-função nos exports do cluster DISPARO e em `slaCalculationService` (1.147/4) — baixo, incremental.

### P2 — Staleness leve nos docs-meta (corrigido em parte nesta sessão)
- `DOCUMENTATION_AUDIT.md`: dizia "série 19–**24**" e webhook "fases **1–2**" — hoje há **25** e o webhook está na **fase 5**. → corrigir referências.
- `16-MAPA-DE-ARQUIVOS-CRITICOS.md`: header fixa `commit-base 66e0771 · 2026-08-23` embora o conteúdo tenha sido atualizado depois — o leitor pode achar que está velho. → atualizar o carimbo quando revisar.

---

## O que está BOM (não mexer "para melhorar")
- `helpers/` e `middleware/` — em geral pequenos e com header; `phoneHelper`, `conversationSync`, `messageStatusHelper`, `whatsappMessageIdHelper` bem cobertos por doc + teste.
- Módulos já fatiados: `controllers/chat/*`, `controllers/dashboard/*`, `services/aiDashboard/*`, `services/atendimentoSemResposta/*`, `controllers/webhookInbound/*` — headers presentes e testes de caracterização.
- `chatbotTriageService.js` (1.880 L, 47 JSDoc) — grande, mas **bem documentado**.

## Como um AI deve navegar hoje (ordem)
1. `CLAUDE.md` (raiz + backend) → 2. `docs/AI_HANDOFF.md` + [00](00-LEIA-PRIMEIRO.md) → 3. mapa [16](16-MAPA-DE-ARQUIVOS-CRITICOS.md) → 4. doc do módulo específico (04/05/06/07 + o mapa de modularização 19–25) → 5. só então o código. Para DISPARO, o passo 4 **falta** (ver P0).
