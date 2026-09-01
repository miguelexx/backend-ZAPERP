# 25 — Auditoria: próximos alvos de modularização / documentação

> Gerado em 2026-09-01 a partir de métricas do código atual. Objetivo: apontar, fora do chat (já
> modularizado — ver [23](23-CHAT-CONTROLLER-MODULARIZACAO.md)), **o que é difícil de uma IA entender/analisar**,
> o que está **mal documentado** e o que vale **modularizar/migrar/organizar** — em ordem de prioridade.
>
> Numeração: a série **19–24** são mapas de modularização. Este arquivo é ranking. O plano P0 do webhook
> é o [24](24-WEBHOOK-INBOUND-MODULARIZACAO.md) (fases 1–2 feitas; `receberZapi`/`statusZapi` ainda no arquivo).

## Como foi medido

Por arquivo (fora de `node_modules`, `tests/`, `scripts/`): linhas, nº de `exports`, nº de `catch`,
`catch` vazios (observabilidade), densidade de JSDoc (`/**`), nº de `require`. O sinal "difícil de analisar"
combina **tamanho + poucas fronteiras (poucos exports p/ muitas linhas) + baixa densidade de doc + catch vazios**.

## Ranking — MODULARIZAÇÃO (maior valor/risco primeiro)

### P0 — `controllers/webhookZapiController.js` (~3.5k linhas + helpers) ⚠️ TOP

- Handler **ATIVO** de inbound/ACK (nome "zapi" é legado; UltraMSG). Ver [06](06-WHATSAPP-ULTRAMSG-E-WEBHOOKS.md).
- Fases 1–2 em `controllers/webhookInbound/` (`payload`, `reopenPolicy`, `whatsappIdLookup`, `fromMeReconcile`).
- `receberZapi` / `statusZapi` ainda no arquivo. **Não** movê-los sem [24](24-WEBHOOK-INBOUND-MODULARIZACAO.md). Não renomear o arquivo.

### P1 — Cluster **DISPARO** (~15k linhas em ~19 arquivos)

Já espalhado (não é um god object). Falta mapa de entrada. Próximo doc sugerido: `26-DISPARO-MAPA.md` (ainda não existe).

### P2 — `services/aiDashboardService.js`

Plano em [22](22-AI-DASHBOARD-MODULARIZACAO.md) (Sessão A feita, B pendente). Não reauditar.

### P2 — `helpers/conversationSync.js`

Usado por chat **e** webhook. Documentar exports; fatiar só depois do 24 e com testes de identidade.

## Ranking — DOCUMENTAÇÃO (baixa densidade)

| Arquivo | Observação |
|---------|------------|
| `controllers/disparoRevisaoController.js` | handlers grandes, quase sem JSDoc |
| `controllers/helpDeskController.js` | API externa em `reference/API-HELPDESK-ICTHUS.md`; controller sem mapa |
| `services/slaCalculationService.js` | fórmulas densas |
| `controllers/disparoLimitesController.js` | limites, denso |

## Recomendação priorizada

1. Webhook: seguir o [24](24-WEBHOOK-INBOUND-MODULARIZACAO.md) **fases 3–5** (`statusZapi` → persistência → `receberZapi` + shim). Não reextrair payload/fromMe. Não “corrigir” fromMe/ACK/HTTP no split.
2. Mapa do Disparo (`26-…`) quando o Miguel pedir.
3. JSDoc em helpDesk / disparoRevisao / SLA.

> Extração verbatim. Untracked do chat (`conversationListController` / `textMessageController` / `pixController`) não descartar.
