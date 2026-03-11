# Deploy da Proteção Operacional

## Pré-requisitos

- Migrations aplicadas no Supabase
- Variáveis de ambiente opcionais configuradas (ver .env.example)

## Migrations

Execute em ordem:

```bash
# Supabase CLI
supabase db push

# Ou manualmente no SQL Editor:
# backend/supabase/migrations/20260312000000_protecao_operacional.sql
```

## Variáveis de Ambiente Recomendadas

```env
# Opcional - usar defaults se não definido
SYNC_BATCH_SIZE=50
QUEUE_MAX_CONCURRENT_JOBS=2
QUEUE_MAX_RETRIES=3
CIRCUIT_BREAKER_FAILURE_THRESHOLD=5
CIRCUIT_BREAKER_RESET_MS=60000
OPERATIONAL_SAFE_MODE_DEFAULT=true
FEATURE_REGRA_AUTO_WEBHOOK=0
FEATURE_CAMPANHAS=0
```

## Rollback

1. Remover worker do index.js (comentar `startWorker`)
2. Reverter webhookZapiController e chatController para versão anterior (sync inline)
3. As tabelas podem permanecer; não afetam o fluxo antigo se o código for revertido
