# 26 — Comunidades (WhatsApp Communities via Whapi)

> Função real de Comunidades. Antes era só um stub (`contactController.criarComunidade` inseria linha local em `conversas`). Agora cria/gerencia comunidades reais via Whapi, com fila protegida para adição de participantes. **Admin-only.**

## Provider (só Whapi; UltraMSG → 501)
`services/providers/whapi/community.js` (espelha `groups.js`: `wrap/mutate/contactIds`), registrado em `services/providers/whapi/index.js`. Endpoints REST confirmados (gate.whapi.cloud):
- `POST /communities` criar · `GET /communities` listar · `GET /communities/{cid}` obter · `GET /communities/{cid}/subgroups`
- `POST /communities/{cid}` criar grupo na comunidade · `PUT|DELETE /communities/{cid}/{gid}` vincular/desvincular
- `POST|DELETE /communities/{cid}/participants` add/remove · `PATCH|DELETE /communities/{cid}/admins` promover/rebaixar
- `PATCH /communities/{cid}/settings` (setting: modify_groups|member_add_mode, policy: anyone|admins) · `DELETE /communities/{cid}` desativar · `DELETE /communities/{cid}/invite` revogar
- `cid`/`gid` no formato `@g.us` (via `toWhapiGroupId`). `add`/`createGroupInCommunity` passam pelo `whatsappSendGuardService` (espaçamento por instância); reads/settings/invite usam `skipSendGuard`.
- **A confirmar no 1º teste real:** unlink (DELETE /{cid}/{gid}), demote (DELETE /{cid}/admins), revoke invite (DELETE /{cid}/invite).

## Fila de participantes (proteção da conta)
Migration `20261009120000_comunidades_fila.sql` (em `migrations/` e `supabase/migrations/`) — **Miguel roda no Supabase Editor antes do deploy**. 2 tabelas: `comunidade_operacoes` (lote) + `comunidade_fila_itens` (1 por participante) + RPCs `comunidade_claim_fila_itens` (SKIP LOCKED, só de operações em_execucao), `comunidade_recuperar_leases`, `comunidade_try_lock_instancia`/`comunidade_unlock_instancia` (advisory namespace **872015**). Fonte de verdade das comunidades é a Whapi ao vivo — **sem tabela-espelho**.

- `services/comunidade/comunidadeFilaService.js`: `enfileirarParticipantes` (normaliza `contactIds` + dedup + **pré-filtro** contra `getCommunity().participants` + dedup contra itens ativos; idempotência `op:{id}:p:{jid}`), `recalcularContadores`, `alterarStatusOperacao` (pausar/retomar/cancelar), `pausarOperacaoAutomatica`.
- `workers/comunidadeWorker.js`: embutido na API (`index.js` `startComunidadeWorker(io)`). 1 item por vez, advisory lock por instância, **gate ultra-conservador** (intervalo+jitter, teto/hora e /dia por instância), backoff (`disparoFilaRetryHelper`), **pausa automática da operação em 429/rate limit**, `failed` da Whapi (anti-spam) é terminal. Limites por instância em `whatsapp_instances.metadata.comunidade_limites`; defaults em `helpers/comunidadeWorkerConfig.js` (env `COMUNIDADE_*`). Kill switch: `COMUNIDADE_WORKER_ENABLED=false`.
- `services/comunidade/comunidadeSocketService.js`: emite a `empresa_{id}` (`comunidade_operacao_atualizada|concluida|pausada`, `comunidade_item_atualizado`).

## HTTP
`routes/comunidadeRoutes.js` (montado em `/comunidades` no `app.js`), todas `auth + adminOnly`. `/operacoes*` antes de `/:cid`. Controller `controllers/comunidadeController.js` (padrão de `groupAdminController`: `company_id` de `req.user`, `resolveWhatsappInstanceForManualAction`, `needMethod`→501, `sendProviderResult`). Stub antigo `POST /chats/comunidades` ficou intacto (não usado pela UI nova).

## Frontend
`pages/Comunidades.jsx` (admin-only, rota `/comunidades` em `AppRoutes.jsx`, nav em `MainLayout`), `comunidades/comunidadesService.js`, `comunidades/comunidadesStore.js`, `comunidades/comunidades.css` (classes `.cm-*`, tokens `--ds-*`). Listeners socket **só em `socket/socket.js`** (bloco `off→on`). Antiga `/atendimento/nova-comunidade` → redirect para `/comunidades`.

## Testes
`tests/whapiCommunity.test.js` (provider), `tests/comunidadeWorker.test.js` (resultado add + gate). Suite completa: 2258 verdes.
