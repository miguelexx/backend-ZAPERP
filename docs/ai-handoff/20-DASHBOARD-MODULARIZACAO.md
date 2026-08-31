# 20 — Dashboard: mapa da modularização

> Criado: **2026-08-31**. Fonte: código atual.  
> Quebra de `controllers/dashboardController.js` (~1.966 linhas). Fachada estável. Sem migration.

Fachada: [`controllers/dashboardController.js`](../../controllers/dashboardController.js)  
Implementação: [`controllers/dashboard/`](../../controllers/dashboard/)  
Rotas: [`routes/dashboardRoutes.js`](../../routes/dashboardRoutes.js) (inalteradas).

## Pastas

```
controllers/dashboard/
  helpers.js           datas SP, fetchAllRows, nomes de usuários
  overview.js          GET /dashboard/overview
  metrics.js           GET /metrics e /metrics-avancadas
  crmResumo.js         GET /crm-resumo (CRM Avançado externo)
  departamentos.js     CRUD setores + grupos
  respostasSalvas.js   CRUD respostas rápidas
  relatorios.js        conversas, mensagens, export
  sla.js               config, alertas, resumo, diária, export, validação
  index.js             re-export da API HTTP
```

`require('../controllers/dashboardController')` continua válido.

## O que foi apagado (obsoleto / morto)

| Item | Motivo |
|------|--------|
| `startOfToday`, `toPositiveInt`, `getDateRangeFromQuery` | definidos e nunca chamados |
| `avg` / `round1` / `percent` / `buildGroupRanking` | só se usavam entre si; nenhum handler chamava |
| `fetchDepartamentosNomeMap`, `fetchMensagensForConversas` | definidos e nunca chamados |
| `calcTaxaConversao` + query `crm_leads` | tabela dropada na migration `20260812120000_drop_crm_legacy_module.sql` |

O JSON de `/overview` **ainda inclui** `kpis.taxa_conversao_percent`, agora sempre `null`, para não quebrar o painel.

## O que NÃO mudou

Handlers, filtros `company_id` do JWT, payloads, sockets (nenhum), flag `FEATURE_METRICAS_AVANCADAS`, `crm-resumo` (CRM externo via `crmSyncService`), SLA via `slaCalculationService`.

## Testes

`tests/auth.test.js` cobre 401 em overview/metrics. Não há suite de contrato do dashboard.

```text
NODE_ENV=test ZAPERP_DISABLE_BACKGROUND_JOBS=1 npx jest tests/auth.test.js --runInBand
```
