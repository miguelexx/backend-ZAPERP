# Deploy e operação

> Análise estática: 2026-08-23 · `master` · `66e0771d9f61f840524cd4b0645e742df374a77a` · fontes: `package.json`, `ecosystem.config.js`, `index.js`, health checks e scripts. Nenhum deploy/migration foi executado.

## Processo identificado

Não há build: é CommonJS executado por `node index.js`. `ecosystem.config.js` confirma PM2, modo `fork`, **dois** apps: API HTTP (`whatsapp-plataforma-backend`, 1 instância) e worker de Disparo opcional (`whatsapp-plataforma-disparo-worker`, 1 instância, `autorestart`, `kill_timeout` 35s). Docker/Compose e CI/CD não existem no backend. Forma exata de transferência para VPS, diretório, proxy TLS e comando PM2 usado no servidor são **NÃO CONFIRMADOS** — o repositório passa a declarar os dois processos; o deploy precisa `pm2 startOrReload ecosystem.config.js` (ou equivalente). O worker de Disparo também sobe **dentro da API**; o segundo app PM2 é extra.

## Sequência segura proposta (não executada)

1. congelar/identificar commit e salvar backup verificável;
2. inventariar schema real e migrations já aplicadas — não confiar em `schema.sql`;
3. ensaiar migrations pendentes em clone de produção, na ordem cronológica, com prechecks;
4. decidir janela/pausa de worker e jobs; reconciliar itens `enviando/incerta`;
5. instalar com `npm ci`, testar e verificar env por nome sem imprimir valor;
6. aplicar migrations autorizadas antes do código que depende delas, ou usar compatibilidade explícita da migration quando prevista;
7. recarregar apenas uma instância PM2;
8. verificar health/log de boot/auth e fluxos somente com tenant/número de homologação;
9. observar erros, fila, webhooks/ACK e storage antes de liberar jobs/live.

A ordem exata de cada migration depende do estado real e é **PENDENTE DE VALIDAÇÃO**. Há migration Etapa 9 não rastreada no working tree; não aplicá-la automaticamente.

## Checks e logs

- `/health`: liveness do Express; `/health/detailed`: acesso Supabase. Nenhum prova UltraMSG/R2/jobs.
- Logs úteis: boot/fail-fast, request id/status/latência, resolução de webhook, scheduler, R2, Disparo worker/heartbeat e PM2 stderr/stdout.
- Não consultar logs com query token sem sanitização. Telefone, corpo de mensagem e payload de webhook são PII.
- Não há `build_sha`; comparar versão implantada exige acesso autorizado ao artefato/commit/processo. Não foi possível comparar código local e VPS.

## Rollback

Rollback de aplicação: restaurar artefato/commit anterior e recarregar uma instância. Rollback de banco **não pode ser presumido reversível**; preferir migration forward compatível ou restore ensaiado. Se código novo gravou novos estados/colunas, reverter só o Node pode ser incompatível. Mídia removida por retenção pode ser irrecuperável fora de backup.

## Smoke test seguro pós-deploy

Health, auth inválida, login de conta de homologação, listagem tenant-scoped, conexão Socket.IO da conta de homologação e consulta de status sem reiniciar instância. Envio/recebimento, mídia, cron, sync e campanha somente com autorização explícita e recursos de homologação.

## Cuidados operacionais

- manter PM2 HTTP `instances: 1`; não clusterizar sem Redis/pub-sub e locks distribuídos;
- worker de Disparo é o segundo app do `ecosystem.config.js` (`instances: 1`); não subir duas cópias do mesmo `DISPARO_WORKER_ID` sem necessidade — o claim é atômico, mas o heartbeat fica ambíguo;
- não executar schedulers internos e cron externo duplicados;
- disco `/uploads` deve persistir entre releases; em múltiplos hosts não é compartilhado;
- preservar env/cofre fora do repositório; rotacionar exemplos com aparência de credencial;
- antes de restart, entender leases e mensagens externas aceitas ainda sem ACK.

