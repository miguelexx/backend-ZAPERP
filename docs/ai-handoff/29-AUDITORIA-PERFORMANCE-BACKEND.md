# 29 — Auditoria de performance do backend (Conversas/Atendimento)

> Data: **2026-09-29** · branch `master` · working tree limpo antes das mudanças.
> Escopo: endpoints de chat, queries/índices, paginação, Socket.IO, envio outbound,
> webhook inbound, concorrência, memória/CPU e logs. Regra seguida: **não alterar o que
> está correto** — só ganho real, bug ou risco de concorrência.

---

> **REVISÃO DE 09/11/2026 — leia [40](40-AUDITORIA-ESCALA-GARGALOS-2026-11-09.md) antes de agir sobre qualquer item daqui.**
> Os itens 2, 4, 5, 6, 11 e 12 da seção 3 foram CORRIGIDOS (não deployado); 1, 3 (metade) e 7
> já estavam corrigidos por sessões posteriores sem este doc ter sido atualizado; a seção 2
> (índices) foi **aplicada em produção em 23/10/2026**. Cada item abaixo traz o seu estado.

## 1. O que foi ALTERADO nesta auditoria (não deployado)

| # | Arquivo | Mudança | Motivo |
|---|---------|---------|--------|
| 1 | `services/chat/outbound/idempotencyHelpers.js` | `isMissingMensagemColumnError` retorna `false` para `code 23505` | 23505 de `client_temp_id` era classificado como "coluna ausente" (o texto do erro cita a coluna) → removia o campo, chamava `markDbDedupeUnavailable()` (dedup desligada até restart) e **reinseria a linha = mensagem duplicada ao cliente**. Coluna ausente real é 42703. |
| 2 | `controllers/webhookZapiController.js` (~:946) | Removido `skipCache: true` do `syncUltraMsgContact` | HTTP síncrono ao provider (contato + foto com rate-limit de 2s/instância) rodava em **toda** mensagem inbound/fromMe. Agora o cache de 5 min curto-circuita repetidas; primeira mensagem do contato mantém sync completo; o sync em background pós-200 segue existindo. |
| 3 | `services/chat/unread/conversationUnreadService.js` + `helpers/modoSimplesGrupoUnread.js` | `obterUnreadMap` com `.gt('unread_count', 0)`; `marcarComoLidaPorUsuario` com writes condicionais (`.gt(0)` / `.eq('lida', false)`) | Linhas zeradas nunca são apagadas → admin acumula 1 linha por conversa e o PostgREST **corta em 1000 linhas sem ordem** → badges de não lida sumiam aleatoriamente. Writes condicionais evitam UPDATE morto em toda abertura/paginação de conversa. Consumidores tratam chave ausente como 0 (verificado). |
| 4 | `controllers/chat/conversationDetailController.js:58` | `messageHistoryFetchLimit = limit + 1` (era `limit + 75`) | `splitMessageHistoryPage` corta em `limit` ANTES dos filtros de ocultas/movimentação; as +75 linhas (com todas as colunas) eram descartadas em toda abertura e "carregar mais". |
| 5 | `services/chat/read/pagination.js` | `.lte()` redundante antes do `.or(lt,and(eq,lt))` nos dois cursores (lista e mensagens) | O Postgres não deriva range do OR → cada página varria desde o topo do índice (custo tipo OFFSET). O `.lte` preserva a semântica (o OR já implica `<=`) e habilita range scan. |
| 6 | `helpers/conversationSync.js` (`mergeAndReturnCliente`) | `pushname` só entra em `updates` se mudou | UPDATE em `clientes` em TODA mensagem inbound (2× por mensagem: sync + webhook), com WAL/trigger à toa. |
| 7 | `services/chat/realtime/chatRealtimeGateway.js`, `setorVisibilidadeRealtime.js`, `helpers/chatbotRealtimeEmitter.js`, `services/disparoSendService.js` | Emits consolidados em `io.to([rooms]).emit(...)` — **mesmas salas e eventos de antes** | Emits sequenciais entregavam o mesmo evento 2-4× a sockets presentes em `empresa_`+`conversa_`+`departamento_`, e o forEach por usuário serializava o payload N vezes (caminho de todo `nova_mensagem` inbound). Socket.IO deduplica sockets num emit multi-room. |
| 8 | `index.js` (`canUserJoinConversationRoom`) | Delegado a `assertPermissaoConversa` (política HTTP canônica) | O join divergia nos 2 sentidos: não aplicava `atendenteNaoPodeVerAssumidaPorOutro` (atendente do mesmo setor entrava na room de conversa assumida por outro e lia tudo em realtime, com HTTP 403) e negava conversa encerrada de outro setor (que o HTTP libera). Teste de rooms usa stub de `canJoin` — não afetado. |
| 9 | `services/chat/access/conversationVisibilityService.js` | Varredura periódica (60s, `unref`) + teto de 2000 entradas no `conversaVisibilityCache` | Entradas vencidas só saíam ao reconsultar a MESMA conversa → leak lento (uma chave por conversa desde o boot). |
| 10 | `middleware/resolveWebhookCompany.js`, `absenceFinalizationScheduler.js`, `adminAtendimentoAlertaScheduler.js`, `tests/atendimentoUnreadErrors.test.js` | Log duplicado do webhook removido (caminho de sucesso); schedulers só logam quando há trabalho/acionável; mock do teste ganhou `.gt` | ~1000 linhas/dia de log sem informação. Logs de erro/auditoria intactos. |

**Testes:** suíte completa rodada após as mudanças (ver resultado no relatório da sessão).
**Deploy:** nada commitado/pushado. Nenhuma migration necessária para o código acima.

---

## 2. Índices — **APLICADO EM PRODUÇÃO 23/10/2026**

> **CORRIGIDO 23/10/2026 (aplicado).** Os quatro índices viraram a migration
> `supabase/migrations/20261023180000_indices_lista_nulls_last.sql`, que registra a confirmação
> em produção com os planos medidos (Index Scan / Index Only Scan). **Não há CREATE a fazer.**
> Os `DROP` continuam pendentes de evidência de `pg_stat_user_indexes` — SQL final em [40](40-AUDITORIA-ESCALA-GARGALOS-2026-11-09.md)
> §3.5, que também registra o achado novo: o custo dominante passou a ser o **planning** (~4 ms),
> por causa dos ~35 índices de `conversas`. O texto abaixo fica como histórico.

Verificado nas migrations: `idx_conversas_company_atividade_id` é `(company_id, ultima_atividade DESC, id DESC)` = NULLS FIRST, e a lista ordena com `nullsFirst:false` (NULLS LAST) → o índice não serve à ordenação principal. O parcial `idx_conversas_company_ultima_atividade` (NULLS LAST) tem `WHERE status != 'fechada'` e não é elegível. `atendimentos` não tem índice começando por `de_usuario_id`/`para_usuario_id`, usados em todo GET /chats e /counts de não-admin.

```sql
-- ganho direto (lista e counts)
CREATE INDEX IF NOT EXISTS idx_atendimentos_company_de_usuario_transferiu
  ON public.atendimentos (company_id, de_usuario_id, criado_em DESC)
  WHERE acao = 'transferiu';

CREATE INDEX IF NOT EXISTS idx_atendimentos_company_para_usuario_transferiu
  ON public.atendimentos (company_id, para_usuario_id, criado_em DESC)
  WHERE acao = 'transferiu';

CREATE INDEX IF NOT EXISTS idx_conversas_company_atividade_id_nulls_last
  ON public.conversas (company_id, ultima_atividade DESC NULLS LAST, id DESC);

CREATE INDEX IF NOT EXISTS idx_conversa_unreads_company_usuario_positive
  ON public.conversa_unreads (company_id, usuario_id, conversa_id)
  WHERE unread_count > 0;
```

Depois de confirmar uso do novo índice de conversas (`pg_stat_user_indexes.idx_scan`), dropar redundantes — **cada UPDATE de `conversas.ultima_atividade` (toda mensagem) mantém ~35 índices**, então remover pagam-se na escrita:

```sql
-- DROP INDEX IF EXISTS public.idx_conversas_company_atividade_id;      -- substituído pelo NULLS LAST
-- DROP INDEX IF EXISTS public.idx_conversa_atendentes_conversa_active; -- idêntico ao UNIQUE conversa_atendentes_active_unique
-- DROP INDEX IF EXISTS public.idx_clientes_company_telefone;           -- coberto pelo UNIQUE idx_clientes_company_telefone_unique
-- DROP INDEX IF EXISTS public.idx_mensagens_company_conversa;          -- prefixo de idx_mensagens_company_conversa_criado_id
```

---

## 3. Problemas REAIS confirmados, NÃO corrigidos (decisão do Miguel / risco maior)

Ordenados por impacto. Detalhe completo no relatório da sessão de 2026-09-29.

1. **CORRIGIDO EM GRANDE PARTE (antes de 09/11/2026).** `chatRealtimeGateway.js:91-116` e o inbound (`webhookZapiController.js:2591`) já emitem escopado a quem pode ver a conversa. Sobram em `empresa_`: `chatbotRealtimeEmitter.js:91,138` (vale escopar) e os emits de remoção/merge (corretos assim). A redundância `atualizar_conversa` + `conversa_atualizada` no inbound continua e é mudança de contrato — ver [40](40-AUDITORIA-ESCALA-GARGALOS-2026-11-09.md) §3.1. Texto original: **`atualizar_conversa` para `empresa_` = tempestade de refetch.** Cada evento faz todo cliente dar `GET /chats/:id`; quem não vê a conversa recebe 403 + resync da lista inteira. Emissores: `emitirSincronizacaoListaConversas` (gateway :165), inbound (`webhookZapiController` ~:2409, redundante com o `conversa_atualizada` logo depois), bot, e o scheduler `aguardandoClienteMonitorService` num loop de até 300 conversas. Correção: restringir aos visíveis / remover o redundante do inbound — muda contrato com o frontend, testar junto.
2. **CORRIGIDO 09/11/2026 (não deployado).** A corrida do ACK já estava resolvida pela guarda atômica em `patchMensagemStatusById` (F3 do doc 33). Os 10 UPDATEs incondicionais pós-provedor (outbound ×5, forward, pix, retry e os dois `catch` de transporte em texto/mídia) passaram a usar `gravarResultadoDoEnvio`, que condiciona o status a `IN (pending,sending,erro,failed)` **e grava os ids mesmo quando a linha já avançou** — um `.in()` cru perderia o `whatsapp_id`. Teste: `tests/statusNaoRegrideNosEnvios.test.js`. Texto original: **Status pode regredir**: UPDATEs incondicionais pós-provider (`text:501`, `media:472`, outbound/forward/pix/retry) e corrida ler-rank/gravar no `statusZapi`. Correção: `.in('status', ['pending','sending'])` nos controllers e update com filtro de rank no ACK. Anti-padrão 3 documenta a regra.
3. **METADE JÁ CORRIGIDA; a outra é PROPOSTA.** `reabrirChat` **já** tem o UPDATE condicional (`attendanceController.js:313`) e não toma conversa de ninguém. `encerrarChat` segue **sem guarda** (`:103`) — duplo clique = 2 registros + 2 mensagens ao cliente; é regra de negócio, proposta com SQL/semântica em [40](40-AUDITORIA-ESCALA-GARGALOS-2026-11-09.md) §3.2. Texto original: **`encerrarChat` sem guarda** (duplo clique = 2 registros + 2 mensagens de finalização ao cliente) e **`reabrirChat` pode tomar conversa já reaberta por outro**. Correções tocam regra de negócio (re-finalizar) — confirmar antes.
4. **CORRIGIDO 09/11/2026 (não deployado), com uma pendência.** O encaminhamento **já** injetava `crm-{id}` via Proxy (`forwardController.js:68-99`). A finalização MANUAL passou a inserir antes do POST para levar `referenceId: crm-{id}` + gravação condicional + `provider_queue_id` (antes descartado). A finalização por **ausência** só ganhou o `provider_queue_id`: inserir-antes ali esbarra na regra de não criar bolha em recusa definitiva — ver [40](40-AUDITORIA-ESCALA-GARGALOS-2026-11-09.md) §4.3. Teste: `tests/finalizacaoReferenceId.test.js`. Texto original: **Encaminhamento e mensagem de finalização saem sem `referenceId`** → sweep pode reenviar ao cliente algo já entregue; finalização também corre com o eco (linha duplicada). Correção: `crm-{id}` nesses envios + `provider_queue_id` na finalização.
5. **CORRIGIDO 09/11/2026 (não deployado).** O fallback do `sendVoice` agora exige falha **definitiva** (reusa `isTransientOutboundFailure`); 5xx/408/425/429 devolvem a falha com `httpStatus` e `transient: true`, e a linha fica pending + reconciliação. O cartão Pix **já** estava restrito (`pixController.js:261`). Teste: `tests/sendVoiceFallbackDefinitivo.test.js`. Texto original: **`sendVoice` faz fallback para `/messages/audio` em QUALQUER falha** (inclusive 5xx/ambígua) com o mesmo referenceId → 2 áudios ao cliente. Cartão Pix Whapi idem (cartão + texto). Restringir fallback a erro definitivo.
6. **PARCIALMENTE CORRIGIDO 09/11/2026 (não deployado).** Feito: a dedup por `whatsapp_id` não roda mais 2× (o HIT da guarda de reentrega é reaproveitado; o MISS continua reconsultado, por causa de reentrega concorrente) e `whatsapp_instances` + a flag de `empresas` ganharam cache TTL por `company_id` via o novo `helpers/shortTtlCache.js`. `ia_config` do chatbot **já** tinha cache. **NÃO feito, de propósito:** as leituras repetidas de `conversas` são releituras deliberadas contra snapshot velho em webhooks paralelos (comentário em `webhookZapiController.js:~1636`) — memoizar ressuscita o bug; e o chatbot continua antes do insert. Teste: `tests/inboundCacheEDedup.test.js`. Texto original: **Inbound ainda faz ~25-30 round-trips**: dedup de reentrega roda tarde e em duplicidade (~:1269 e ~:1894, mesma query), leituras repetidas da mesma conversa (3-5×), `empresas`/`whatsapp_instances`/`ia_config` sem cache no caminho quente (4-8 queries/msg), chatbot roda ANTES do insert (operador só vê a mensagem depois do bot responder — mudar exige cuidado com a semântica de "primeira mensagem"), Whapi processa lote em série e 500 num item reprocessa o lote todo.
7. ~~**Supervisão**: `getResumo`+`getClientesPendentes` a cada 30s por aba de admin…~~ **CORRIGIDO 23/10/2026 (não deployado).** O alvo certo não eram os dois endpoints e sim `buildConversationInsights`, que é a raiz do custo (6 queries, incluindo `listLastMessagesByConversation` sobre TODAS as conversas abertas) e é chamado de **sete** sítios do serviço — cacheá-lo resolve os sete. `supervisaoService.js` ganhou cache por `company_id` com TTL de 15 s (`SUPERVISAO_INSIGHTS_TTL_MS`, ajustável por env) **e coalescing**: a promessa fica guardada em voo, então várias abas de admin a fazer poll ao mesmo tempo partilham UMA execução. Chave é **sempre** o `company_id` (isolamento aqui é app-layer). Falha **não** é cacheada. Prune com TTL + teto, no mesmo padrão do `conversationVisibilityService`. **Seguro porque:** conferido que nenhum dos sete chamadores muta `insights.*` — os `.sort()` existentes vêm sempre depois de `.filter()`/`.map()`, que criam array novo (se alguém um dia ordenar `insights.pending` no lugar, tem de copiar antes). TTL < o poll de 30 s do painel, logo a defasagem máxima é um ciclo. Teste: `tests/supervisaoInsightsCache.test.js`, validado com 4 mutações (sem cache, sem coalescing, chave sem tenant = vazamento, falha cacheada).
8. **JÁ ESCRITA (confirmar se aplicada).** `supabase/migrations/20261023181000_webhook_logs_retencao.sql` cria `webhook_logs_cleanup(dias DEFAULT 30, tamanho_lote DEFAULT 20000)` com pg_cron documentado; há duas migrations de acerto depois (`20261026000000`, `20261026001000`). Confira se a rotina é FUNCTION ou ainda a PROCEDURE antiga — query em [40](40-AUDITORIA-ESCALA-GARGALOS-2026-11-09.md) §3.4. Texto original: **`webhook_logs` sem retenção** com 9 índices (1 INSERT por webhook, ACKs = 2-3× o volume de mensagens). Criar job/pg_cron de retenção (7-30 dias).
9. **CONFIRMADO; migration + backfill escritos, NÃO aplicados.** `chatListCountsService.js:650` para no teto de `CHAT_FILTER_ID_LIMIT` (2000). A causa-raiz é só o `rowHasMessage` — todo o resto de `rowVisibleInPostFilteredList` já está em `conversas`. SQL completo (coluna + backfill em lotes + trigger + índice parcial) em [40](40-AUDITORIA-ESCALA-GARGALOS-2026-11-09.md) §3.3. Texto original: **Contadores `minha_fila`/`aberta`/`em_atendimento`** varrem até 2000 linhas com embed lateral por linha e **erram acima de 2000**. Causa-raiz: "tem mensagem?" não denormalizado em `conversas`.
10. **`minhasPendencias`**: `listLastMessagesByConversation` pagina TODAS as mensagens com OFFSET; `listRespostasAtendenteAposTransferencias` sem limite/data.
11. **CORRIGIDO 09/11/2026 (não deployado), em parte.** Novo `helpers/limiteConcorrencia.js` (sem dependência nova) limita downloads inbound (3) e espelhamento R2 (2); o `-wa.mp4`/`-wa.jpg` órfão do **encaminhamento** é removido (preservando o arquivo que o provedor ainda vai buscar pela URL devolvida); o upload abortado no 422 de áudio é apagado. **NÃO mexido:** o `/media/proxy` baixando o arquivo inteiro por Range e a varredura R2 sem cursor. Teste: `tests/midiaConcorrenciaEOrfaos.test.js`. Texto original: **Mídia**: downloads inbound/espelhamento R2 sem teto de concorrência (picos de N×80 MB), proxy `/media/proxy` baixa o arquivo INTEIRO a cada request de Range, varredura R2 sem cursor pode travar nas mesmas linhas, arquivos `*-wa.mp4/jpg` órfãos no encaminhamento e upload não removido no 422 de áudio.
12. **CORRIGIDO 09/11/2026 (não deployado).** O fallback 3 do `statusZapi` passou a cercar o candidato pelas conversas do telefone do wamid (novo `resolveConversaIdsDoAckPorTelefone`, extraído do 3b); telefone conhecido sem conversa na empresa deixa de cair na heurística. A “Busca 2” do eco `fromMe` ficou restrita às conversas do **mesmo contato** (mesmo `cliente_id` ou mesmo telefone ± 9º dígito) em vez da empresa inteira. Grupo (`@g.us`, sem telefone extraível) mantém a heurística anterior. Teste: `tests/ackCorrelacaoEntreConversas.test.js`. Texto original: **ACK correlaciona entre conversas** (fallback 3 do `statusZapi` e "Busca 2" do fromMe usam a empresa toda, sem filtrar telefone) — raro, mas grava status/whatsapp_id na linha errada.
13. **Reenvio manual aceita linha `pending`** (estado "provedor PODE ter recebido") sem consultar o provedor e sem trava compartilhada com o sweep.
14. **Mapas por conversa sem TTL** no chatbot (`lastWelcomeSentAt` etc.), `_lastSyncByConv`, presença — leak lento (~0,3-1 MB/dia).
15. **Logs por mensagem** ainda ~7-15 linhas (pipeline/resolveKey/chatbot INÍCIO “sempre visível”; texto da mensagem e telefone completo logados — atenção LGPD).

## 4. Analisado e CORRETO (não mexer)

- Autenticação socket (JWT handshake, `company_id` obrigatório), isolamento entre empresas nas salas, `conversationRooms` (corrida join/leave), listeners registrados 1× por conexão, payloads de socket enxutos.
- Idempotência de texto/arquivo (`client_temp_id` + unique), reconciliação de eco por `crm-{id}`/`whatsapp_id`, classificação transitório×definitivo (2026-09-21), sweep que consulta o provedor antes de reenviar, emissão otimista antes do provider (intencional).
- Assumir/transferir com UPDATE condicional (409 para quem perde), unicidade de cliente/conversa/mensagem com tratamento de 23505.
- Paginação por cursor (lista e mensagens; sem OFFSET), última mensagem via embed `limit 1` (sem N+1), enriquecimentos em lote, busca por RPC unaccent, counts com cache 10s + timeout.
- Mídia inbound/R2/push/CRM fora do caminho síncrono do webhook; `webhook_logs` pós-`finish`; guardas de replay/idade cedo.
- Schedulers com `started`/`running`/`unref`; caches com TTL (idempotência, foto, counts, sync contato, chatbot config); locks liberados em `finally`; `unhandledRejection` não derruba o processo.
