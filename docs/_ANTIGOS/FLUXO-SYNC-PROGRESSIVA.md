# Fluxo de Sincronização Progressiva

## Conceito

Em vez de processar todos os contatos de uma vez, processa em lotes com pausa entre eles.

## Parâmetros

| Parâmetro | Default | Descrição |
|-----------|---------|-----------|
| lote_max | 50 | Contatos por lote |
| intervalo_lotes_seg | 5 | Segundos entre lotes |
| maxPages | 20 | Máximo de páginas por execução |

## Fluxo

1. Job na fila com **`tipo` = `sync_contatos`** (identificador do job; ver tabela `jobs`)
2. Worker pega o job, marca `running`
3. `syncContactsFullProgressiva` (implementação em `contactSyncService`):
   - Obtém config (lote, intervalo)
   - Loop: `syncContactsProgressiva` por lote
   - Entre lotes: `await sleep(intervalo_lotes_seg * 1000)`
   - Atualiza checkpoint após cada lote **bem-sucedido** (falha de config/provider não avança página)
   - Para se `processamento_pausado` ou fim dos dados
4. Ao concluir: marca job `completed`, emite socket `zapi_sync_contatos`

## Checkpoint

- Tabela: `checkpoints_sync`
- Chave: **`(company_id, tipo='contact_sync')`** — alinhado ao serviço de sync progressiva (não confundir com o `tipo` do job = `sync_contatos`)
- Campo: `ultimo_offset` = próxima página a processar

## Lock

- Tabela: `sync_locks`
- Chave: **`(company_id, tipo='contact_sync')`**
- `INSERT` (unique) adquire; falha 23505 = outra sync ativa. Liberado no `finally` (sucesso ou erro)
