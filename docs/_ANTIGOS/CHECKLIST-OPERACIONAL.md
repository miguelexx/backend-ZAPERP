# Checklist Operacional Pós-Deploy

## Verificações

- [ ] Migrations aplicadas (configuracoes_operacionais, jobs, auditoria_eventos, checkpoints_sync, sync_locks)
- [ ] Backend inicia sem erro (worker da fila)
- [ ] Conectar WhatsApp: ao conectar, não executa sync inline (verificar logs)
- [ ] Configurações > Operacional: carrega config, lista jobs, enfileira sync
- [ ] Sync manual (Clientes): enfileira job, resultado via socket ao concluir
- [ ] zapi_auto_sync_contatos: default false para novas empresas
- [ ] Modo seguro ativo por padrão

## Testes Rápidos

1. Conectar instância Z-API
2. Verificar que job sync_contatos aparece em Operacional > Fila
3. Aguardar conclusão e verificar evento em Auditoria operacional
4. Pausar processamento e tentar sync — deve ficar pending
