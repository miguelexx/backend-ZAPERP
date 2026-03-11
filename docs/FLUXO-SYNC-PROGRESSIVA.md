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

1. Job `sync_contatos` é enfileirado
2. Worker pega o job, marca `running`
3. `syncContactsFullProgressiva`:
   - Obtém config (lote, intervalo)
   - Loop: `syncContactsProgressiva` por lote
   - Entre lotes: `await sleep(intervalo_lotes_seg * 1000)`
   - Atualiza checkpoint após cada lote
   - Para se `processamento_pausado` ou fim dos dados
4. Ao concluir: marca job `completed`, emite socket `zapi_sync_contatos`

## Checkpoint

- Tabela: `checkpoints_sync`
- Chave: `(company_id, tipo='sync_contatos')`
- Campo: `ultimo_offset` = próxima página a processar

## Lock

- Tabela: `sync_locks`
- Evita duas sync do mesmo tipo simultâneas
- Adquirido no início, liberado no fim (ou em erro)
