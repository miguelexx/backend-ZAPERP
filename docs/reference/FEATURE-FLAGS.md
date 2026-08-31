# Feature Flags (ENV)

> Atualizado: 2026-08-24. Flags lidas em `helpers/featureFlags.js`.  
> **`FEATURE_CAMPANHAS` foi removida** junto com o módulo de campanhas legado (migration `20260812140000_drop_campanhas_module.sql`). O módulo atual chama-se **Disparo**: gate de produto `empresas.modulo_campanhas_ativo` + env `DISPARO_WORKER_ENABLED` / `DISPARO_LIVE_ENABLED` / `DISPARO_DRY_RUN`.

Flags para ativar funcionalidades sem alterar código. Quando não definida ou com valor diferente de `1` / `true` / `yes`, a feature fica **desativada**.

| Variável | Descrição | Padrão |
|----------|-----------|--------|
| `FEATURE_OPT_OUT_WEBHOOK` | Processar comandos PARAR/SAIR/DESCADASTRAR no webhook inbound | desativada |
| `FEATURE_REGRA_AUTO_WEBHOOK` | Processar regras automáticas por palavra-chave no webhook inbound | desativada |
| `FEATURE_PROTECAO` | Ativa verificação de volume/frequência/opt-in antes de cada envio | desativada |
| `FEATURE_METRICAS_AVANCADAS` | Habilita endpoint `GET /dashboard/metrics-avancadas` | desativada |

**Nota sobre `FEATURE_PROTECAO`:**  
Além desta flag, há um override hard-coded: `const PROTECAO_DESATIVADA = true` em `services/protecao/protecaoOrchestrator.js`. Para ativar a proteção em produção, é necessário: (1) mudar essa constante para `false` **e** (2) definir `FEATURE_PROTECAO=1`. Só a flag não é suficiente. Ver detalhes em [`PROTECAO-ENVIO.md`](PROTECAO-ENVIO.md).

**Exemplo `.env`:**
```
FEATURE_OPT_OUT_WEBHOOK=1
FEATURE_REGRA_AUTO_WEBHOOK=1
FEATURE_METRICAS_AVANCADAS=1
# FEATURE_PROTECAO=1  ← requer calibrar limites + mudar PROTECAO_DESATIVADA antes de ativar
```
