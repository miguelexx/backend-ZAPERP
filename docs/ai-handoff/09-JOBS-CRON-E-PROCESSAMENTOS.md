# Jobs, cron e processamentos assíncronos

> Análise estática: 2026-08-23 · `master` · commit-base `66e0771d9f61f840524cd4b0645e742df374a77a` · fontes: `index.js`, `jobs/`, `services/*Scheduler*`, `routes/jobsRoutes.js`, `controllers/jobsController.js`, `workers/disparoWorker.js`.

## Inicialização

O processo HTTP inicia schedulers após subir Socket.IO, exceto em `NODE_ENV=test` ou com `ZAPERP_DISABLE_BACKGROUND_JOBS`. São timers Node no mesmo processo; guards/locks JS evitam sobreposição apenas local. Reinício perde contadores, locks e próximo tick. PM2 usa uma instância justamente compatível com essa arquitetura.

| Processo | Frequência/primeira execução confirmada | Efeito |
|---|---|---|
| fila genérica de tarefas | poll 5 s, concorrência 2 | claim, execução, backoff e recuperação de stale timeout. |
| finalização por ausência | 5 min / 20 s | encerra/atualiza conversas elegíveis. |
| alerta admin atendimento | 2 min / 25 s | detecta e notifica alertas. |
| atendimento sem resposta | 1 min / 35 s | gera/atualiza alertas e sockets. |
| sync de produtos | 30 min / 30 s, somente com duas flags | SQL Server → PostgreSQL externo. |
| reconciliação outbound pendente | 5 min / 45 s | consulta/reclassifica mensagens pendentes. |
| redirecionamento de triagem | 1 min / 30 s | move conversas sem escolha/tempo. |
| retry inbound agendado | 1 min; sweep completo 3 h | reprocessa side effects inbound. |
| mirror de mídia R2 | 5 min | copia arquivos elegíveis conforme rollout. |
| retenção R2/local | 24 h, somente se habilitada | remove mídia vencida preservando registro lógico. |

Valores podem ser sobrescritos por env; tabela descreve defaults observados.

## Endpoints de cron

`POST /jobs/{timeout-inatividade,timeout-inatividade-chatbot,finalizacao-ausencia-cliente,vencimento-pagamento-financeiro,finalizacao-ausencia-lote,admin-atendimento-alerta,atendimento-sem-resposta}` exige `X-Cron-Secret`. As rotinas sobrepõem parcialmente os schedulers internos; não habilitar chamada externa e timer sem entender idempotência. A origem/agendador de produção é **NÃO CONFIRMADO**.

Há ainda a fila operacional autenticada (JWT + supervisor/admin) no mesmo prefixo: `GET /jobs/`, enfileiramento `sync-contatos`/`sync-fotos`, pausa/retomada global da empresa e retry por id. `queueManager` persiste jobs e o poller os executa; o sub-router não possui `/operacional` no caminho efetivo.

## Worker de Disparo

Processo **separado** do HTTP: `npm run worker:disparo` ou, em produção, o app PM2 `whatsapp-plataforma-disparo-worker` em `ecosystem.config.js` (fork, 1 instância, `autorestart`, `kill_timeout` 35s). A API **não** processa a fila.

Com `DISPARO_WORKER_ENABLED=false` o processo **permanece vivo** e grava heartbeat `disabled` (para o PM2 não entrar em loop de restart). A fila só é claimada com `DISPARO_WORKER_ENABLED=true`. Envio real só ocorre quando `DISPARO_WORKER_ENABLED=true`, `DISPARO_LIVE_ENABLED=true` e `DISPARO_DRY_RUN=false`. Poll default 2 s, heartbeat 10 s, lease 120 s, lote 5.

A fila é persistente; claim usa RPC PostgreSQL com `SKIP LOCKED`/advisory lock. Backoff e leases recuperam crash. Lease expirado em `reservada` volta a pendente; `enviando` vira `incerta`. Item com provider id/data de envio não é reenviado automaticamente. Heartbeat em `disparo_worker_heartbeat`; o painel classifica `ativo` / `iniciando` / `sem_heartbeat` / `desabilitado` / `offline` (ativo = heartbeat running nos últimos 45s, sem flag de shutdown).

## Concorrência e escala

- Dois processos HTTP duplicariam timers; guards em memória não coordenam hosts.
- Rate limits, dedupe rápido, presença e locks de sync são perdidos no restart.
- O worker de Disparo possui coordenação persistente melhor, mas configuração de múltiplos workers e SQL real precisa teste controlado.
- Retenção e mirror fazem efeitos de filesystem/storage; habilitação errada pode apagar mídia.
- Jobs devem ser idempotentes por estado/constraint. Quando não houver prova, tratar reexecução como **PENDENTE DE VALIDAÇÃO**.

## Operação segura

Inspecionar flags e número de processos; manter jobs desligados em testes; executar endpoint cron somente com banco de teste e segredo fictício; observar logs/resumo; nunca ligar worker live automaticamente; após crash, reconciliar itens incertos antes de liberar reprocessamento.
