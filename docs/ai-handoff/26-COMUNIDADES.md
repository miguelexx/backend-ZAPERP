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

## Apagar comunidade (WhatsApp + sistema)
`DELETE /comunidades/:cid` → `comunidadeController.apagarComunidade` faz 4 coisas, nesta ordem:
1. `deactivateCommunity` na Whapi (`DELETE /communities/{cid}`) — desativa no WhatsApp para todos (404 da Whapi = já não existia; segue a limpeza local em vez de falhar);
2. `deleteChat(cid)` **best-effort** — remove o chat residual da comunidade do aparelho conectado (não bloqueia se falhar);
3. `fila.cancelarOperacoesDoAlvo` — cancela operações `em_execucao|pausada` daquele `comunidade_id` + itens ativos (emite `comunidade_operacao_atualizada` por operação);
4. **Tombstone** em `whatsapp_instances.metadata.comunidades_removidas` (array de cids, cap 300) — a Whapi pode continuar listando comunidades desativadas por um tempo; `listarComunidades` filtra esses cids para o card nunca voltar. Sem migration (reusa o jsonb `metadata`, mesmo lugar de `comunidade_limites`).

Resposta: `{ ok, whatsapp, chatRemovido, operacoesCanceladas }`. Front: botão de lixeira no card (confirm) + "Apagar comunidade" na aba Configurações do detalhe; remoção otimista da lista.

## Frontend
`pages/Comunidades.jsx` (admin-only, rota `/comunidades` em `AppRoutes.jsx`, nav em `MainLayout`), `comunidades/comunidadesService.js`, `comunidades/comunidadesStore.js`, `comunidades/comunidades.css` (classes `.cm-*`, tokens `--ds-*`). Listeners socket **só em `socket/socket.js`** (bloco `off→on`). Antiga `/atendimento/nova-comunidade` → redirect para `/comunidades`.

## Grupos reusam a MESMA fila (adição em massa, ex. 500 pessoas)
A migration ganhou coluna `tipo` (grupo|comunidade); `comunidade_id` guarda o @g.us do ALVO (grupo OU comunidade). `comunidadeFilaService.enfileirarParticipantes({tipo})` e o worker (`metodoDoProvider(p, tipo, operacao)`) despacham `addGroupParticipant`/`addCommunityParticipant`. Endpoints de grupo em `groupAdminController`: `POST /chats/:id/participantes/fila` (enfileira), `GET /chats/:id/participantes/fila` (progresso do grupo), `POST /chats/:id/participantes/fila/:opId/cancelar`. Frontend: `components/ContatosPicker.jsx` (busca `getClientesComTotal` + paginação + colar em massa), `pages/NovoGrupo.jsx` (cria ≤20 imediato; senão semeia 1 + enfileira o resto), `conversa/components/GrupoBulkAddModal.jsx` (grupo existente, com progresso). Limite grupo 1024, comunidade 2000.

## Testes
`tests/whapiCommunity.test.js` (provider), `tests/comunidadeWorker.test.js` (resultado add + gate; dispatch grupo/comunidade), `tests/comunidadeFila.test.js` (`cancelarOperacoesDoAlvo`). Suite completa: 2258 verdes.

---

## 2026-11-10 — "Não estou conseguindo adicionar ao grupo": era o 9º dígito

Relato do Miguel com o modal aberto: `1/1 · 0 ok · 1 falha · Concluída c/ erros`.

### Medição

As **5 únicas** operações de add gravadas (desde 09/10) falharam **todas** igual:

```
comunidade_fila_itens → status=falhou  erro_codigo=WHATSAPP_RECUSOU
  "O WhatsApp não adicionou este contato (política anti-spam/privacidade)."
  participante_jid: 5534999911246   ← 13 dígitos
```

Não era anti-spam. Perguntando ao próprio canal:

```
POST /contacts {"contacts":["5534999911246"]}
  → {"input":"5534999911246","status":"valid","wa_id":"553499911246@s.whatsapp.net"}
```

O número **discado** tem o 9º dígito; o **JID** do contato no WhatsApp não tem. A fila mandava o
endereço que não existe para `POST /groups/{id}/participants`, a Whapi devolvia o contato em
`failed`, e o worker registrava isso como recusa por política. Mesma família do 9º dígito que
`runOnChatCandidates` já trata nas ações de chat — só que ações de GRUPO mandam a lista de
participantes de uma vez, então não dá para "tentar o outro endereço" por participante.

### O que mudou

| Arquivo | Mudança |
|---|---|
| `services/chat/identity/enderecoWhatsappService.js` (novo) | `resolverEnderecosWhatsapp(provider, telefones, opts)` — uma chamada a `checkPhones` resolve o `wa_id` de vários números. **Falha de consulta nunca vira "não existe"**: devolve o número original com `verificado:false` e a ação segue como antes |
| `workers/comunidadeWorker.js` | Resolve o endereço antes do add; envia o `wa_id`; avalia `processed`/`failed` **contra o endereço enviado** (a resposta ecoa esse, não o discado). Número sem WhatsApp agora falha com `SEM_WHATSAPP` em vez de virar "anti-spam" |
| `controllers/chat/groupAdminController.js` | Mesma resolução no caminho direto (`POST /chats/:id/participantes`) |
| `services/comunidade/comunidadeFilaService.js` | `listarOperacoesDoAlvo` passa a anexar `erros[]` (motivo agrupado + até 5 números por motivo) nas operações com falha |
| `frontend/.../GrupoBulkAddModal.jsx` | Mostra os motivos abaixo da barra — antes a tela dizia só "1 falha" e o porquê ficava no banco. E `~1 dia(s)` para 1 contato virou "Começa em instantes" (`ceil(total/porDia)` dava 1 dia para qualquer quantidade > 0) |

Mensagem de recusa real também ficou acionável: explica que costuma ser a privacidade do contato
("quem pode me adicionar a grupos") e sugere mandar o link de convite.

### Prova no canal da empresa 4 (Vencer), só leitura

```
fila mandava 5534999911246  ->  agora manda 553499911246  <<< CORRIGIDO
fila mandava 5534984079198  ->  agora manda 553484079198  <<< CORRIGIDO
```

### Testes

`tests/adicionarGrupoEnderecoReal.test.js` (11): resolução do wa_id, número sem WhatsApp,
consulta indisponível não bloqueia, provider sem `checkPhones`, lote deduplicado, e o worker
ponta a ponta (manda o wa_id, resposta que ecoa o wa_id conta como sucesso, `SEM_WHATSAPP` sem
chamar o add, recusa real com mensagem de privacidade). Suíte: **3642 testes, 280 suítes, ok**.

### Fora do escopo

Os **403 de `pps.whatsapp.net`** no console do mesmo modal são links assinados **vencidos** em
`clientes.foto_perfil` (`oe=` decodificado: 08/10, 15/10, 19/10 e 05/11 — todos no passado). Não
quebram nada: a lista já cai para as iniciais. O remédio existente é "Sincronizar fotos de
perfil" em Configurações → Clientes. Nada alterado.
