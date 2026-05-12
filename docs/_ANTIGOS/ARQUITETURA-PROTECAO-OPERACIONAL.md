# Arquitetura de Proteção Operacional ZapERP

## Visão Geral

A camada de proteção operacional adiciona controles para reduzir risco de bloqueio no WhatsApp, evitar sincronizações agressivas e privilegiar atendimento humano.

## Componentes Principais

### 1. Fila de Jobs (queueManager)

- **Tabela:** `jobs` (PostgreSQL)
- **Tipos:** `sync_contatos`, `sync_fotos`
- **Fluxo:** Enfileirar → Worker processa → Retry com backoff em falha
- **Concorrência:** Limitada por `QUEUE_MAX_CONCURRENT_JOBS` (default 2)

### 2. Sincronização Progressiva (syncProgressivaService)

- Processa contatos em lotes (default 50)
- Intervalo entre lotes configurável (default 5s)
- Checkpoint em `checkpoints_sync` para retomada
- Lock em `sync_locks` evita sync simultânea

### 3. Configurações Operacionais (configOperacionalService)

- **Tabela:** `configuracoes_operacionais`
- Campos: modo_seguro, processamento_pausado, lote_max, intervalo_lotes_seg, etc.

### 4. Circuit Breaker (circuitBreakerZapi)

- Após N falhas (5xx/429) em getContacts/getProfilePicture, abre circuito
- Reset automático após 60s

### 5. Auditoria Operacional (operationalAuditService)

- **Tabela:** `auditoria_eventos`
- Registra: conexao, sync_inicio, sync_fim, falha, pausa, config_alterada

## Fluxo de Conexão Segura

1. Webhook `/connection` recebe evento connected
2. Aguarda 10s para estabilizar
3. Configura webhooks Z-API
4. Verifica `zapi_auto_sync_contatos` na empresa
5. Se true: enfileira job sync_contatos (não executa inline)
6. Worker processa em background com lotes e intervalos

## Variáveis de Ambiente

Consulte `.env.example` para a lista completa. Principais:

- `SYNC_BATCH_SIZE` — tamanho do lote (default 50)
- `QUEUE_MAX_CONCURRENT_JOBS` — jobs simultâneos (default 2)
- `CIRCUIT_BREAKER_FAILURE_THRESHOLD` — falhas para abrir circuito (default 5)
