# 29 — Auditoria de performance do backend (Conversas/Atendimento)

> Data: **2026-09-29** · branch `master` · working tree limpo antes das mudanças.
> Escopo: endpoints de chat, queries/índices, paginação, Socket.IO, envio outbound,
> webhook inbound, concorrência, memória/CPU e logs. Regra seguida: **não alterar o que
> está correto** — só ganho real, bug ou risco de concorrência.

---

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

## 2. Índices — SQL sugerido (Miguel roda no Supabase Editor; NÃO aplicado)

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

1. **`atualizar_conversa` para `empresa_` = tempestade de refetch.** Cada evento faz todo cliente dar `GET /chats/:id`; quem não vê a conversa recebe 403 + resync da lista inteira. Emissores: `emitirSincronizacaoListaConversas` (gateway :165), inbound (`webhookZapiController` ~:2409, redundante com o `conversa_atualizada` logo depois), bot, e o scheduler `aguardandoClienteMonitorService` num loop de até 300 conversas. Correção: restringir aos visíveis / remover o redundante do inbound — muda contrato com o frontend, testar junto.
2. **Status pode regredir**: UPDATEs incondicionais pós-provider (`text:501`, `media:472`, outbound/forward/pix/retry) e corrida ler-rank/gravar no `statusZapi`. Correção: `.in('status', ['pending','sending'])` nos controllers e update com filtro de rank no ACK. Anti-padrão 3 documenta a regra.
3. **`encerrarChat` sem guarda** (duplo clique = 2 registros + 2 mensagens de finalização ao cliente) e **`reabrirChat` pode tomar conversa já reaberta por outro**. Correções tocam regra de negócio (re-finalizar) — confirmar antes.
4. **Encaminhamento e mensagem de finalização saem sem `referenceId`** → sweep pode reenviar ao cliente algo já entregue; finalização também corre com o eco (linha duplicada). Correção: `crm-{id}` nesses envios + `provider_queue_id` na finalização.
5. **`sendVoice` faz fallback para `/messages/audio` em QUALQUER falha** (inclusive 5xx/ambígua) com o mesmo referenceId → 2 áudios ao cliente. Cartão Pix Whapi idem (cartão + texto). Restringir fallback a erro definitivo.
6. **Inbound ainda faz ~25-30 round-trips**: dedup de reentrega roda tarde e em duplicidade (~:1269 e ~:1894, mesma query), leituras repetidas da mesma conversa (3-5×), `empresas`/`whatsapp_instances`/`ia_config` sem cache no caminho quente (4-8 queries/msg), chatbot roda ANTES do insert (operador só vê a mensagem depois do bot responder — mudar exige cuidado com a semântica de "primeira mensagem"), Whapi processa lote em série e 500 num item reprocessa o lote todo.
7. **Supervisão**: `getResumo`+`getClientesPendentes` a cada 30s por aba de admin, cada um varrendo todas as conversas abertas + mensagens do dia sem teto. Maior consumidor recorrente de CPU/banco. Correção: cache/coalescing 15-30s.
8. **`webhook_logs` sem retenção** com 9 índices (1 INSERT por webhook, ACKs = 2-3× o volume de mensagens). Criar job/pg_cron de retenção (7-30 dias).
9. **Contadores `minha_fila`/`aberta`/`em_atendimento`** varrem até 2000 linhas com embed lateral por linha e **erram acima de 2000**. Causa-raiz: "tem mensagem?" não denormalizado em `conversas`.
10. **`minhasPendencias`**: `listLastMessagesByConversation` pagina TODAS as mensagens com OFFSET; `listRespostasAtendenteAposTransferencias` sem limite/data.
11. **Mídia**: downloads inbound/espelhamento R2 sem teto de concorrência (picos de N×80 MB), proxy `/media/proxy` baixa o arquivo INTEIRO a cada request de Range, varredura R2 sem cursor pode travar nas mesmas linhas, arquivos `*-wa.mp4/jpg` órfãos no encaminhamento e upload não removido no 422 de áudio.
12. **ACK correlaciona entre conversas** (fallback 3 do `statusZapi` e "Busca 2" do fromMe usam a empresa toda, sem filtrar telefone) — raro, mas grava status/whatsapp_id na linha errada.
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
