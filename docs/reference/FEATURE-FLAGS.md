# Feature Flags (ENV)

Flags para ativar funcionalidades do Plano SaaS sem alterar código.

| Variável | Descrição | Valores |
|----------|-----------|---------|
| `FEATURE_OPT_OUT_WEBHOOK` | Processar comandos PARAR, SAIR, DESCADASTRAR no webhook | `1` ou `true` = ativo |
| `FEATURE_REGRA_AUTO_WEBHOOK` | Processar regras automáticas (palavra-chave) no webhook | `1` ou `true` = ativo |
| `FEATURE_CAMPANHAS` | Módulo de campanhas (APIs /campanhas, /opt-in, /opt-out) | `1` ou `true` = ativo |
| `FEATURE_PROTECAO` | Módulos de proteção (frequência, volume, opt-in) | `1` ou `true` = ativo |
| `FEATURE_METRICAS_AVANCADAS` | Endpoint /dashboard/metrics-avancadas | `1` ou `true` = ativo |

**Exemplo .env:**
```
FEATURE_OPT_OUT_WEBHOOK=1
FEATURE_REGRA_AUTO_WEBHOOK=1
FEATURE_CAMPANHAS=1
FEATURE_METRICAS_AVANCADAS=1
```

Quando não definida ou com valor diferente de `1`/`true`/`yes`, a funcionalidade fica **desativada**.
