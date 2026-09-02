# 25 — Próximos alvos: MODULARIZAÇÃO (ranking)

> Atualizado **2026-09-01** com métricas do código atual. Este é o **ranking do que vale fatiar**.
> Legibilidade/documentação (headers, JSDoc, nomes) tem doc próprio: [26](26-AUDITORIA-LEGIBILIDADE-CODIGO.md).
> Mapa de código do DISPARO: [27](27-DISPARO-MAPA.md). Chat já modularizado: [23](23-CHAT-CONTROLLER-MODULARIZACAO.md).

## Como foi medido
Por arquivo (fora de `node_modules`/`tests`/`scripts`): linhas, nº de `exports`/funções, densidade de JSDoc.
Sinal de "vale modularizar" = **tamanho grande + múltiplas responsabilidades distintas no mesmo arquivo**
(não é só linha: um arquivo grande e coeso — ex. fórmulas de SLA — se documenta, não se fatia).

---

## A) RECOMENDO MODULARIZAR (ranking)

| # | Arquivo | LOC | Por quê | Plano / estado |
|---|---------|-----|---------|----------------|
| **1** | `controllers/webhookZapiController.js` | 3.040 | Handler ATIVO inbound/ACK; o miolo de `receberZapi` (~2.800 L) mistura persistência+socket+unread+fromMe | **EM ANDAMENTO** — [24](24-WEBHOOK-INBOUND-MODULARIZACAO.md) fases 1–4 feitas, fase 5 começada (saídas antecipadas extraídas + miolo caracterizado). **Não** mover `receberZapi`/`statusZapi` sem o 24. Não renomear o arquivo. |
| **2** | `services/aiDashboardService.js` | 3.902 | Maior arquivo do repo; classificação de intent + queries + formatação + OpenAI no mesmo service | Plano [22](22-AI-DASHBOARD-MODULARIZACAO.md): Sessão A feita (puros em `aiDashboard/`); **Sessão B pendente** (queries/OpenAI ainda no service). |
| **3** | `controllers/chat/conversationListController.js` | 1.490 | Sub-controller do chat que cresceu demais (lista + filtros + visibilidade); só 2 JSDoc | Sem plano. Fatiar dentro de `controllers/chat/` seguindo o padrão do [23](23-CHAT-CONTROLLER-MODULARIZACAO.md). Untracked — não descartar. |
| **4** | `controllers/disparoRevisaoController.js` | 1.512 | Maior controller do DISPARO (Etapa 6); 46 funções, 1 JSDoc; checklist + revisão + export num só arquivo | Sem plano. Extrair o checklist (já há `helpers/disparoRevisaoChecklist.js`) e handlers de export. Ver mapa [27](27-DISPARO-MAPA.md). |
| **5** | `controllers/chat/attendanceController.js` | 1.197 | Sub-controller do chat grande (atribuição/assumir/transferir/finalizar) | Sem plano. Fatiar dentro de `controllers/chat/`. |

**Próximo passo natural:** terminar o **1** (fase 5 do webhook — miolo do `receberZapi`, já com rede de
caracterização em `tests/receberZapiInbound.test.js`), depois a **Sessão B do 2** (já tem plano).

---

## B) NÃO fatiar — só documentar/JSDoc (grande, mas coeso)

| Arquivo | LOC | Ação |
|---------|-----|------|
| `services/slaCalculationService.js` | 1.147 | Fórmulas de SLA coesas — só JSDoc nas fns exportadas |
| `services/supervisaoService.js` | 1.122 | Métricas de gestão — header já adicionado (2026-09-01); falta JSDoc por-fn |
| `helpers/conversationSync.js` | 1.233 | Helper CRÍTICO (chat+webhook) — documentar exports; fatiar só com testes de identidade e depois do 24 |
| `controllers/disparoLimitesController.js` / `disparoExecucaoController.js` | 1.201 / 1.175 | Coesos por Etapa (5/7) — JSDoc; usar o mapa [27](27-DISPARO-MAPA.md) |
| `services/chatbotTriageService.js` | 1.880 | Grande mas **bem documentado** (47 JSDoc) — deixar |

---

## C) Já resolvido nesta rodada (2026-09-01)
- Headers de arquivo: `whatsappIntegrationController`, `helpDeskController`, `oldMessagesSyncService`,
  `chatListCountsService`, `absenceFinalizationService`, `supervisaoService`, `clienteController`, `disparoController`.
- Desambiguação `aiController` (/ai/ask) × `iaController` (/ia chatbot).
- Mapa de código do DISPARO: [27](27-DISPARO-MAPA.md).

## Regras do split (sempre)
Extração **verbatim** — não “corrigir” fuso/fromMe/ACK/HTTP durante o fatiamento. Suites-gate verdes a
cada fase. Ao mover um bloco, rodar o diff `imports(antes) − imports(depois)` vs corpo (um import perdido
= `ReferenceError` em runtime que o `node --check` NÃO pega — ver a regressão registrada no [24](24-WEBHOOK-INBOUND-MODULARIZACAO.md) §5).
