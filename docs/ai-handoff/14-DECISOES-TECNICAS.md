# Decisões técnicas vigentes

> Registro reconstruído em 2026-08-23 · `master` · commit-base `66e0771d9f61f840524cd4b0645e742df374a77a`. Motivos não escritos no código são marcados; isto não substitui ADR histórico.

## DT-01 — Processo único para HTTP, sockets e schedulers

- **Contexto:** Socket.IO, presença e timers compartilham memória.
- **Decisão atual/evidência:** PM2 `fork`, `instances: 1` em `ecosystem.config.js`; bootstrap em `index.js`.
- **Motivo identificado:** compatibilidade com estado/locks locais; intenção histórica adicional é **NÃO CONFIRMADA**.
- **Consequência:** operação simples, sem alta disponibilidade horizontal; restart perde estado efêmero.
- **Não fazer:** aumentar instâncias ou hosts diretamente.
- **Revisar quando:** houver Redis/pub-sub, adapter Socket.IO, locks/limiter distribuídos e eleição/segregação de jobs.

## DT-02 — Sem Redis/adapter Socket.IO

- **Decisão/evidência:** dependências/configuração não contêm Redis; Socket.IO usa adapter padrão.
- **Consequência:** emits/presença locais ao processo.
- **Não fazer:** assumir broadcast entre processos.
- **Revisar quando:** escala/HA exigir; testar falha e reconexão antes.

## DT-03 — Multitenancy por `company_id` no backend

- **Contexto:** um banco atende várias empresas.
- **Decisão/evidência:** JWT/instância fornecem tenant; queries e migrations incluem `company_id`; testes multiempresa.
- **Motivo:** isolamento lógico confirmado; razão pela escolha de banco compartilhado é **NÃO CONFIRMADA**.
- **Consequência:** toda camada precisa propagar filtro; service role reduz defesa em profundidade.
- **Não fazer:** confiar em tenant do body/query ou em RLS quando usando service role.
- **Revisar quando:** adotar role por tenant/RPC segura ou banco separado.

## DT-04 — Service role do Supabase no servidor

- **Decisão/evidência:** `config/supabase.js` usa `SUPABASE_SERVICE_ROLE_KEY`.
- **Consequência:** operações administrativas/RPCs funcionam, mas RLS é bypass; segredo é crítico.
- **Não fazer:** expor chave ou usar cliente no frontend; omitir filtros.
- **Revisar quando:** for possível separar operações comuns com role restrita.

## DT-05 — Webhook protegido por segredo compartilhado e instância

- **Decisão/evidência:** `requireWebhookToken` timing-safe + resolver de `instanceId`; não há HMAC.
- **Motivo identificado:** formato/capacidade da integração UltraMSG; suporte real a assinatura é **NÃO CONFIRMADO**.
- **Consequência:** rotação/ocultação do token é essencial; query token é legado.
- **Não fazer:** inventar HMAC incompatível nem aceitar tenant do payload.
- **Revisar quando:** provider suportar assinatura/segredo por instância e rotação sem downtime.

## DT-06 — Idempotência por ids, `referenceId` e constraints

- **Decisão/evidência:** ids UltraMSG, `crm-*`, `disp-*`, `client_temp_id`, índices e helpers de status.
- **Consequência:** callbacks/retries podem convergir; falhas ambíguas exigem estado pendente/incerto.
- **Não fazer:** apagar ids, regredir status ou reenviar incerto cegamente.
- **Revisar quando:** criar outbox/inbox transacional ou provider oferecer chave idempotente forte.

## DT-07 — Mídia local com rollout opcional para R2

- **Decisão/evidência:** `/uploads`, `config/r2.js`, mirror/cleanup/retention e allowlist por empresa.
- **Consequência:** compatibilidade progressiva; disco continua relevante; URLs/retention variam por tenant.
- **Não fazer:** habilitar todas/retention/migration-on-boot sem inventário e backup.
- **Revisar quando:** R2 estiver certificado para todos e entrega privada substituir arquivo público.

## DT-08 — Provider UltraMSG com camada de resolução multi-instância

- **Decisão/evidência:** `services/providers/ultramsg.js`, `whatsappInstanceService`, tabela `whatsapp_instances`; alias Z-API mantido.
- **Consequência:** instância faz parte da identidade; legado nulo/default exige fallback controlado.
- **Não fazer:** resolver “primeira ativa” em produção ou permitir provider instance duplicada.
- **Revisar quando:** remover legado após confirmar dados/migrations ou adicionar provider novo via contrato explícito.

## DT-09 — Disparo com worker embarcado no HTTP e três gates de live

- **Decisão/evidência:** `workers/disparoWorker.js` + `index.js`: o loop da fila roda no processo HTTP (`startEmbeddedWorker`). `npm run worker:disparo` continua opcional. Envio real exige worker+live+`dryRun=false`.
- **Consequência:** clicar em iniciar campanha processa a fila sem processo extra (PM2 só sobe `index.js`). Heartbeat passa a existir no HTTP. Kill switch: `DISPARO_EMBEDDED_WORKER=false`.
- **Não fazer:** reduzir gates de live, auto-reenviar `incerta`, ligar `DISPARO_LIVE_ENABLED` automaticamente.
- **Revisar quando:** homologação, observabilidade tenant-safe e runbook estiverem completos.
- **Revisado em:** 2026-08-27 — a regra anterior (“não iniciar worker no HTTP”) impedia disparo em produção, porque o worker separado não está no `ecosystem.config.js`.

## DT-10 — Migrations como fonte canônica

- **Decisão/evidência:** cabeçalho de `supabase/schema.sql` diz ser contexto; evolução está em `supabase/migrations`.
- **Consequência:** estado final depende da ordem e do banco real.
- **Não fazer:** gerar migration a partir do schema estático ou reaplicar arquivos às cegas.
- **Revisar quando:** houver mecanismo formal de versionamento/introspecção do banco.

