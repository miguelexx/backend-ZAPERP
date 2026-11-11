# 40 — Gargalos de escala: o que foi corrigido e o que ficou de proposta (09/11/2026)

> Sessão de 2026-11-09 · branch `master` · **nada commitado, nada pushado, nenhuma migration executada**.
> Escopo: reverificar no CÓDIGO ATUAL os itens de [29](29-AUDITORIA-PERFORMANCE-BACKEND.md) §2/§3 e
> corrigir **só** o que ainda existia. Baseline da suíte antes de mexer: **272 suítes / 3525 testes, 0 falhas**.
> Depois: **278 suítes / 3604 testes, 0 falhas**.

---

## 0. A lição desta sessão: o doc 29 estava desatualizado em 5 dos 13 itens

Metade do trabalho foi **descobrir que já estava feito**. Antes de corrigir qualquer item do doc 29,
confira no código — vários foram resolvidos por sessões posteriores (F3/F7/F9 do doc 33, as
migrations de 23/10) sem que o doc 29 fosse atualizado.

| Item do doc 29 | Estado real em 09/11/2026 | Onde está a prova |
|---|---|---|
| §3.1 tempestade `atualizar_conversa` | **quase todo corrigido** — gateway e inbound já emitem escopado | `chatRealtimeGateway.js:91-116`, `webhookZapiController.js:2591` |
| §3.2 corrida no ACK | **já corrigido** (guarda atômica no UPDATE) | `whatsappIdLookup.js:242` `patchMensagemStatusById` |
| §3.3 `reabrirChat` toma conversa de outro | **já corrigido** (UPDATE condicional) | `attendanceController.js:313` `.eq('status_atendimento', perm.conv.status_atendimento)` |
| §3.4 encaminhamento sem `referenceId` | **já corrigido** (Proxy injeta `crm-{id}`) | `forwardController.js:68-99` |
| §3.5 cartão Pix com fallback cego | **já corrigido** | `pixController.js:261` `cartaoFalhaTransitoria` |
| §2 índices da lista | **escritos E APLICADOS em produção 23/10** | `supabase/migrations/20261023180000_indices_lista_nulls_last.sql` |
| §3.8 retenção de `webhook_logs` | **escrita** (função + pg_cron documentado) | `supabase/migrations/20261023181000_webhook_logs_retencao.sql` |

**Corrija o doc 29, não o código,** quando cair num destes.

---

## 1. Achados NOVOS desta sessão (não estavam em nenhum doc)

### 1.1 `git status` do repo RAIZ mente sobre o trabalho em curso do backend

O repo raiz (`whatsapp-plataforma`) **também rastreia** os arquivos de `backend/` como arquivos
normais, além de `backend/` ser um repo aninhado. O último commit da raiz é um
`chore: sincroniza o repo raiz…`, então o `git status` da raiz lista como `M` **tudo o que mudou no
backend desde aquela sincronização** — inclusive o que já está commitado no histórico do próprio
backend.

```
# ❌ ERRADO — a raiz lista ~40 arquivos de backend/ como "modificados"
cd whatsapp-plataforma && git status

# ✅ CORRETO — a verdade sobre trabalho não commitado do backend
cd whatsapp-plataforma/backend && git status --short
```

Nesta sessão a raiz acusava `M backend/controllers/chat/attendanceController.js` (entre muitos
outros) enquanto o repo do backend o dava como **limpo**. Tratar a lista da raiz como "trabalho não
commitado do Miguel" congela quase todo o backend sem motivo.

### 1.2 Um `.in('status', …)` cru no lugar do helper PERDE o `whatsapp_id`

A correção pedida pelo doc 29 §3.2 é "UPDATE condicional". Escrita como
`.update({status, whatsapp_id}).in('status', [...])` ela tem um efeito colateral silencioso: quando
o ACK já avançou a linha, o UPDATE não casa **nada** — e o `whatsapp_id`/`provider_queue_id`
devolvidos pelo provedor **também** não são gravados. Sem esses ids, o ACK seguinte e a varredura
perdem a única forma de correlacionar a linha.

`services/chat/outbound/outboundResultPersistence.js` (`gravarResultadoDoEnvio`) já resolvia isso —
grava o status **só** se a linha está aberta e, quando já avançou, grava **apenas os ids**. É por
isso que os caminhos de envio passaram a usar o helper em vez de ganhar um `.in()` cada.

### 1.3 As leituras repetidas de `conversas` no inbound NÃO podem ser memoizadas

O doc 29 §3.6 pede "evitar ler a mesma conversa 3-5× no mesmo fluxo". **Não dá**, e o motivo está
escrito no próprio código:

```js
// webhookZapiController.js:~1636
// Human takeover: não processar chatbot se atendente já assumiu a conversa
// Revalida departamento/atendente no banco (snapshot inicial pode estar stale em webhooks paralelos).
```

Essas releituras **são** a correção de um bug anterior (snapshot velho em webhooks paralelos), e
outras estão intercaladas com UPDATEs na mesma linha. Memoizá-las ressuscita o bug. Por isso só as
leituras de **configuração** (`empresas`, `whatsapp_instances`) foram cacheadas nesta sessão.

### 1.4 `-wa.mp4` / `-wa.jpg` órfãos: o vazamento é no ENCAMINHAMENTO, não na normalização

`mediaNormalizers.js` limpa o convertido no ramo de erro. O vazamento real é em
`forwardMediaResolver.js`: ele chama a normalização com `removeSource: false` (certo — a mídia de
origem é a mídia salva, não um temporário de upload) e o `finally` só removia o temporário do R2.
O **convertido** ficava em `/uploads` a cada encaminhamento de vídeo/imagem.

Cuidado ao limpar: quando o provider não tem `uploadMedia`, o resolver devolve a URL pública **do
próprio convertido** e o provedor vai buscá-la DEPOIS do retorno. Apagar nesse caso dá 404. A
limpeza implementada pula exatamente esse arquivo (compara o basename com a URL devolvida).

### 1.5 A varredura de reconciliação NÃO pode sair do processo HTTP

Ver §3.6 abaixo (item 12). `pendingOutboundReconciliationService.js:845` consulta
`despachoEmAndamento(row.id)` — um `Set` **local ao processo** alimentado pelo envio HTTP. Fora do
processo da API, a varredura perde essa informação e pode reenviar uma mensagem cujo despacho ainda
está em voo: **duplicata no cliente**.

---

## 2. O que FOI alterado (não deployado)

Nenhuma migration, nenhum contrato de Socket.IO, nenhuma rota, nenhum formato de resposta HTTP.

| # | Arquivos | Mudança |
|---|---|---|
| 1 | `outboundController.js` (5 sítios), `forwardController.js`, `pixController.js`, `retryController.js`, `textMessageController.js`, `mediaMessageController.js` | Gravação pós-provedor passa por `gravarResultadoDoEnvio` → UPDATE condicionado a `status IN (pending, sending, erro, failed)`, ids gravados mesmo quando a linha já avançou |
| 2 | `services/providers/ultramsg/audio.js` | `sendVoice` só cai para `/messages/audio` em falha **definitiva**; transitória (5xx/408/425/429) devolve a falha com `httpStatus` + `transient: true` |
| 3 | `attendanceController.js`, `absenceFinalizationService.js` | Finalização manual: INSERT antes do POST → `referenceId: crm-{id}` + gravação condicional + `provider_queue_id`. Ausência: passa a guardar `provider_queue_id` (era descartado) |
| 4 | **novo** `helpers/shortTtlCache.js`, `whatsappInstanceService.js`, `webhookZapiController.js` | Cache TTL por `company_id` para `whatsapp_instances` e a flag de `empresas` do inbound; dedup por `whatsapp_id` deixa de rodar 2× |
| 5 | **novo** `helpers/limiteConcorrencia.js`, `inboundMediaPersistenceService.js`, `mediaR2MirrorService.js`, `forwardMediaResolver.js`, `mediaMessageController.js` | Teto de concorrência nos downloads inbound e no espelhamento R2; `-wa.*` órfão removido; upload apagado no 422 de áudio |
| 6 | `fromMeReconcile.js`, `statusZapi.js`, `fromMeReceivedReconcile.js` | ACK/eco deixam de correlacionar entre conversas: fallback 3 cercado pelo telefone do wamid, "Busca 2" restrita às conversas do mesmo contato |

### Envs novas (todas com default seguro, nenhuma obrigatória)

| Env | Default | Efeito |
|---|---|---|
| `WHATSAPP_INSTANCE_CACHE_TTL_MS` | `15000` | TTL do cache de `whatsapp_instances` |
| `INBOUND_EMPRESA_FLAG_CACHE_TTL_MS` | `30000` | TTL da flag `separar_mensagens_disparadas` |
| `INBOUND_MEDIA_DOWNLOAD_CONCURRENCY` | `3` | Downloads de mídia inbound simultâneos |
| `R2_MIRROR_CONCURRENCY` | `2` | Uploads simultâneos ao R2 |

### Invariantes a preservar

- **Toda chave de `shortTtlCache` contém `company_id`.** `create()` exige `name` e `wrap()` exige
  `companyId`; sem tenant válido ele **não cacheia** (executa o loader direto) em vez de usar uma
  chave global. O isolamento aqui é app-layer — uma chave sem tenant é vazamento, não só cache errado.
- **`includeCredentials` faz parte da chave** do cache de instância: ele troca o select entre
  `PUBLIC_SELECT` e `PRIVATE_SELECT`. Sem isso, um chamador público receberia o token, ou o adapter
  receberia a linha sem token e o envio falharia.
- **Resultado com `error` não é cacheado** em `getWhatsappInstanceById`/`getDefaultWhatsappInstance`:
  "instância não encontrada" tem de voltar fresco assim que o admin criar/ativar a instância.
- **Os três mutadores invalidam o cache** (`createWhatsappInstance`, `updateWhatsappInstance`,
  `setDefaultWhatsappInstance`). Ao adicionar um quarto caminho de escrita em `whatsapp_instances`,
  chame `invalidateWhatsappInstanceCache(company_id)` — senão o adapter usa token velho por um TTL.
- **O cache devolve cópia rasa.** Nenhum chamador muta o objeto hoje; a cópia garante que continue
  verdade.
- **Só o HIT da dedup de reentrega é reaproveitado.** Um MISS é reconsultado no ponto da
  idempotência, porque entre os dois pontos rodam a reabertura e o chatbot e uma reentrega
  **concorrente** pode ter inserido a linha nesse intervalo.
- **`getWhatsappInstanceByProviderInstanceId` NÃO foi cacheado** de propósito: ele resolve *qual
  empresa* é a dona da instância, então não há `company_id` para pôr na chave. Cachear exigiria uma
  chave global (`provider:instanceId`), contra a regra acima — ver §3.7.

---

## 3. Propostas (analisadas, NÃO implementadas)

### 3.1 `atualizar_conversa` para `empresa_` (doc 29 §3.1) — quase resolvido

Já escopado: `chatRealtimeGateway.js` (via `emitirEventoConversaVisivel`) e o inbound
(`webhookZapiController.js:2591`, via `emitirParaUsuariosQuePodemVerConversa`).

Ainda em `empresa_`:

| Emissor | Avaliação |
|---|---|
| `helpers/chatbotRealtimeEmitter.js:91,138` | **vale escopar** — mensagem do bot é caminho quente; mesmo padrão do gateway |
| `helpers/conversationSync.js:119,126` (`room = empresa_${id}`) | **deixar** — merge de duplicata; todos têm de tirar a conversa morta da lista |
| `conversationDeletionService.js:145` (`removida: true`) | **deixar** — mesmo motivo |
| `aguardandoClienteMonitorService` (laço de até 300) | já escopado (passa pelo gateway), mas são até 300 conversas por ciclo |

**Redundância que sobra:** o inbound emite `atualizar_conversa` (que faz o cliente dar
`GET /chats/:id`) e, logo depois, `conversa_atualizada` **com o payload completo**. O primeiro é
redundante. Remover é mudança de contrato com o frontend.

Consumidor único no frontend: `src/socket/socket.js:1972` — debounce por conversa, `fetchChatById`,
e em `!data` marca `needsListResync` (refetch da lista inteira). É daí que vem a tempestade: quem
não vê a conversa leva 403 → `needsListResync`.

**Plano de teste conjunto:** 2 abas (admin + atendente sem acesso à conversa) com Network aberto;
mandar 10 inbounds na mesma conversa; contar `GET /chats/:id` e `GET /chats` por aba. Esperado após
remover o emit redundante: zero `GET /chats/:id` na aba do atendente sem acesso e nenhum resync de
lista; a aba do admin continua atualizando o card pelo `conversa_atualizada`.

### 3.2 `encerrarChat` sem guarda (doc 29 §3.3) — CONFIRMADO, é regra de negócio

`attendanceController.js:103` grava `status_atendimento: 'fechada'` **sem** filtrar o status atual.
Duplo clique = 2 UPDATEs bem-sucedidos → 2 `registrarAtendimento('encerrou')` → **2 mensagens de
finalização ao cliente** (e, com a correção do item 3, 2 linhas inseridas).

`reabrirChat` **já** tem a guarda certa e serve de modelo (`:313`).

Proposta (precisa da sua decisão porque muda o que acontece ao re-finalizar):

```js
// Mesmo padrão do reabrirChat: só fecha se ainda não estava fechada.
.eq('company_id', company_id)
.eq('id', conversa_id)
.not('status_atendimento', 'in', '("fechada","finalizada")')
```

Com `!data` (ninguém casou) a resposta deve ser **200 idempotente** (`{ ok: true, conversa: <linha
atual> }`), **não** 409: o doc 32 registra que devolver erro depois de a conversa já estar fechada
fazia o frontend reverter o card para "Em atendimento". A decisão sua é: re-encerrar uma conversa
já fechada deve (a) ser no-op silencioso — recomendo — ou (b) voltar a registrar atendimento e
reenviar a mensagem de finalização.

### 3.3 Contadores errados acima de 2000 (doc 29 §3.9) — migration + backfill

`services/chatListCountsService.js:650` `countConversasWithPostListRules` pagina até
`getChatFilterIdLimit()` (2000 default, teto 5000) com embed lateral `mensagens(id)` por linha e
**para** no teto — acima disso o número exibido é simplesmente menor que o real.

Causa-raiz: de tudo que `rowVisibleInPostFilteredList` (`:582`) avalia, **só** `rowHasMessage(row)`
não está em `conversas` — é o que obriga o embed e a varredura. Denormalizado, o contador volta a
ser um `count(*)` exato sem teto.

```sql
-- ============================================================
-- NÃO APLICADO — denormaliza "a conversa tem mensagem?"
-- Rodar os 4 passos em ordem, conferindo cada um.
-- ============================================================

-- 1) coluna (default false: nenhuma linha existente passa a contar por acidente)
ALTER TABLE public.conversas
  ADD COLUMN IF NOT EXISTS tem_mensagem boolean NOT NULL DEFAULT false;

-- 2) BACKFILL em lotes (NÃO fazer num UPDATE único: 31.849 conversas × subquery
--    em mensagens prende a tabela inteira). Rodar até devolver 0.
WITH alvo AS (
  SELECT c.id
    FROM public.conversas c
   WHERE c.tem_mensagem = false
     AND EXISTS (SELECT 1 FROM public.mensagens m WHERE m.conversa_id = c.id)
   LIMIT 5000
   FOR UPDATE SKIP LOCKED
)
UPDATE public.conversas c
   SET tem_mensagem = true
  FROM alvo
 WHERE c.id = alvo.id;
-- conferir quantas faltam:
--   SELECT count(*) FROM public.conversas c WHERE c.tem_mensagem = false
--     AND EXISTS (SELECT 1 FROM public.mensagens m WHERE m.conversa_id = c.id);

-- 3) trigger: cobre webhook, envio, import e sync de uma vez (não dá para
--    confiar em acertar todos os caminhos no código — são muitos).
CREATE OR REPLACE FUNCTION public.conversas_marcar_tem_mensagem()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.conversas
     SET tem_mensagem = true
   WHERE id = NEW.conversa_id
     AND company_id = NEW.company_id
     AND tem_mensagem = false;   -- condicional: sem UPDATE morto por mensagem
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_conversas_tem_mensagem ON public.mensagens;
CREATE TRIGGER trg_conversas_tem_mensagem
  AFTER INSERT ON public.mensagens
  FOR EACH ROW EXECUTE FUNCTION public.conversas_marcar_tem_mensagem();

-- 4) índice parcial para as abas que exigem mensagem
CREATE INDEX IF NOT EXISTS idx_conversas_company_tem_mensagem
  ON public.conversas (company_id, ultima_atividade DESC NULLS LAST, id DESC)
  WHERE tem_mensagem = true;
```

**Ordem obrigatória:** migration aplicada **antes** do deploy do código que lê `tem_mensagem`
(anti-padrão 14). E o código novo tem de tolerar a coluna ausente (o padrão
`isMissingColumnError` já usado no projeto), senão uma instalação sem a migration perde o contador.
`tem_mensagem` nunca volta para `false` — apagar mensagens não é caminho coberto; se isso passar a
importar, o trigger precisa de um par no `AFTER DELETE`.

### 3.4 Retenção de `webhook_logs` (doc 29 §3.8) — JÁ ESCRITA

`supabase/migrations/20261023181000_webhook_logs_retencao.sql` cria
`public.webhook_logs_cleanup(dias integer DEFAULT 30, tamanho_lote integer DEFAULT 20000)` — período
configurável, um lote por chamada (porque o SQL Editor do Supabase envolve tudo numa transação e
`COMMIT` dentro de PROCEDURE é recusado ali), com o pg_cron pronto no comentário:

```sql
-- NÃO APLICADO (agendamento)
CREATE EXTENSION IF NOT EXISTS pg_cron;
SELECT cron.schedule(
  'webhook-logs-retencao',
  '20 4 * * *',
  $job$ SELECT public.webhook_logs_cleanup(30, 50000); $job$
);
-- conferir: SELECT * FROM cron.job;
```

Há duas migrations de acerto depois dela (`20261026000000`, `20261026001000`), e a primeira diz que
a versão PROCEDURE "foi aplicada no banco" — então **confirme o estado real** antes de rodar:

```sql
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, p.prokind
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'webhook_logs_cleanup';
-- esperado: 1 linha, prokind = 'f' (function). 'p' = ainda é a PROCEDURE antiga.
```

### 3.5 Índices do doc 29 §2 — JÁ APLICADOS; só os DROPs continuam pendentes

`20261023180000_indices_lista_nulls_last.sql` registra os quatro criados e **confirmados em
produção em 23/10/2026**, com planos medidos (Index Scan / Index Only Scan). Não há CREATE a fazer.

O achado que ficou aberto nessa migration é mais interessante que os índices: o **planejamento**
passou a dominar — 4,111 ms de planning × 0,278 ms de execução em `conversas`, porque a tabela tem
~35 índices e o planner avalia todos. O ganho agora está em **remover** índice morto.

```sql
-- ============================================================
-- NÃO APLICADO — passo 1: EVIDÊNCIA (só leitura, rodar primeiro)
-- ============================================================
SELECT indexrelname, idx_scan,
       pg_size_pretty(pg_relation_size(indexrelid)) AS tamanho
  FROM pg_stat_user_indexes
 WHERE relname = 'conversas'
 ORDER BY idx_scan ASC, pg_relation_size(indexrelid) DESC;

-- E confirmar que o novo assumiu o lugar do antigo:
SELECT indexrelname, idx_scan
  FROM pg_stat_user_indexes
 WHERE indexrelname IN ('idx_conversas_company_atividade_id_nulls_last',
                        'idx_conversas_company_atividade_id');

-- Desde quando as estatísticas acumulam (idx_scan = 0 só vale se houver dias de tráfego):
SELECT stats_reset FROM pg_stat_database WHERE datname = current_database();
```

```sql
-- ============================================================
-- NÃO APLICADO — passo 2: DROPs, só com a evidência acima na mão
-- Cada índice removido alivia o planning de TODA query e o custo
-- de escrita de TODA mensagem (o UPDATE de ultima_atividade mantém
-- todos eles). Um por vez, conferindo a lista entre cada um.
-- ============================================================
-- DROP INDEX IF EXISTS public.idx_conversas_company_atividade_id;      -- redundante: substituído pelo NULLS LAST
-- DROP INDEX IF EXISTS public.idx_conversa_atendentes_conversa_active; -- idêntico ao UNIQUE conversa_atendentes_active_unique
-- DROP INDEX IF EXISTS public.idx_clientes_company_telefone;           -- coberto pelo UNIQUE idx_clientes_company_telefone_unique
-- DROP INDEX IF EXISTS public.idx_mensagens_company_conversa;          -- prefixo de idx_mensagens_company_conversa_criado_id

-- E o barato que ainda não foi feito (Heap Fetches: 29 no Index Only Scan):
-- VACUUM (ANALYZE) public.conversas;
```

Não dropar índice que sustenta UNIQUE/PK nem parcial de regra de negócio sem conferir quem o usa.
Há diagnósticos prontos em `20261025230000_indices_sem_uso_diagnostico.sql` e
`20261025233000_indices_redundantes_diagnostico.sql`.

### 3.6 Tirar schedulers e worker do processo HTTP (doc 29) — a maioria NÃO pode sair

O bloqueio não é o estado em memória de cada scheduler (são invólucros finos); são **duas**
dependências do processo da API.

**(a) `io` — Socket.IO.** Doze dos arranques recebem `io` (`index.js:300-335`). Num processo
separado não existe o servidor Socket.IO com os clientes conectados, então o realtime simplesmente
não sai. Fazer sair exige pub/sub entre processos — **Redis, que está fora do escopo desta tarefa** —
e o anti-padrão 13 (`instances: 1`) é a mesma restrição.

**(b) Estado em memória compartilhado com o caminho HTTP** — pior que o `io`, porque a falha é
silenciosa e duplica mensagem no cliente:

| Estado | Escrito por | Lido por | Se separar |
|---|---|---|---|
| `outboundDispatchRegistry` (`Set`) | envio HTTP (`mediaMessageController`) | **varredura** (`pendingOutboundReconciliationService.js:845`) | a varredura reenvia mensagem cujo despacho HTTP está em voo → **duplicata** |
| `_acksTardios` (`Map`) | webhook de ACK | o próprio retry de 800/2500/7000 ms | ACK adiantado deixa de ser reaplicado |
| `emExecucao` / `retentativasAgendadas` | webhook inbound + `inboundMediaReprocessController` | varreduras de mídia | mesma mídia baixada 2× em paralelo |
| `_reenviosEmAndamento` (`Set`) | `retryController` (HTTP) | o próprio | duplo clique volta a duplicar |
| `recentClosedConversationGuard` | `encerrarChat` (HTTP) | webhook inbound | eco da finalização reabre a conversa (anti-padrão 7) |
| caches/limitadores novos | ambos | ambos | só perda de eficiência, sem bug |

**Podem sair com segurança** (sem `io`, sem estado compartilhado — todos só leem e logam/escrevem
no banco):

- `startAdminAtendimentoAlertaScheduler()`
- `startAckHealthScheduler()`
- `startProdutosSyncScheduler()`

**Não podem sair sem pub/sub:** tudo que recebe `io`, e em especial
`startPendingOutboundReconciliationScheduler` + `startDisparoWorker` + `startComunidadeWorker`
(estes dois últimos também têm gates de taxa por conta em memória).

Recomendação: o ganho de tirar três schedulers de leitura é pequeno; o risco de tirar os outros é
mensagem duplicada no cliente. **Não vale mexer agora.** Se o objetivo for aliviar CPU do processo
web, o caminho com melhor relação risco/ganho é o §3.5 (menos índices = menos planning e menos
custo de escrita por mensagem).

### 3.7 Cachear `getWhatsappInstanceByProviderInstanceId` (decisão sua)

É a leitura de `whatsapp_instances` do caminho **mais** quente: roda em todo webhook
(`middleware/resolveWebhookCompany.js:108`, `resolveWhapiWebhookCompany.js:72`,
`statusZapi.js:157`, `instanceResolve.js:24`) e ACK é 2-3× o volume de mensagem. Ficou **fora** do
cache porque a função resolve *qual empresa* é dona da instância — não existe `company_id` na
chamada, então a chave teria de ser global (`provider:instanceId`), e a regra desta tarefa é que
toda chave de cache contenha `company_id`.

O valor cacheado seria "esta instância pertence à empresa X", que não é dado de uma empresa vazando
para outra — mas a regra é sua. Se autorizar, o mesmo `shortTtlCache` serve com uma função
`wrapGlobal`, e a invalidação já existe nos três mutadores.

### 3.8 Frontend: chunk `ConversaView` (436 KB no `dist` atual)

Medido em `dist/assets/`: `ConversaView-BGe0R3mF.js` **436 KB**, seguido de `socket` 204 KB,
`index` 156 KB, `chatList` 156 KB.

O que **já** está lazy (não reaproveitar como ideia): todos os modais e painéis secundários, em
`components/ConversaViewOverlays.jsx` — `SidebarCliente`, `OrcamentoDrawer`, `ForwardModal`,
`ShareContact/Location`, `SendPollModal`, `PixConfigModal`, `MsgInfoModal`, `CallModal`,
`AddToGroupModal`, `MediaViewerOverlay`, `ProdutoConsultaPanel`.

Então os 436 KB são o **núcleo**. Fontes maiores dentro dele:

| Fonte | KB | Precisa na 1ª pintura? |
|---|---|---|
| `ConversaView.jsx` | 132 | sim (é o componente) |
| `conversaOutboundMediaMerge.js` | 104 | **não** — só no reconcile de mídia enviada |
| `conversaStore.js` | 100 | sim |
| `utils/conversaViewHelpers.js` | 44 | sim |
| `hooks/useForwardFlow.js` | 44 | **não** — só ao encaminhar |
| `hooks/useConversationOutboundMedia.js` | 44 | só ao enviar mídia |

**Proposta, em ordem de risco crescente — nenhuma fase toca as zonas de perigo**
(`useAutoScroll`, `visualViewport`, `.wa-selectBar`, `.wa-pinBar`, virtualização/`chatsStore`,
`AudioWavePlayer`):

- **Fase 1 — risco zero, ganho a medir.** Os modais são lazy mas **os hooks que os alimentam são
  importados estaticamente** (`useSendCatalog`, `useSendPoll`, `useShareContact`,
  `useShareLocation`, `useAddToGroup`, `useConversationCall`, `usePixConfig`, `useForwardFlow`).
  A lógica deles entra no chunk principal mesmo que o modal não abra. Mover o corpo pesado para
  trás da mesma fronteira dinâmica do modal (import dinâmico na primeira invocação, hook devolvendo
  só o disparador) tira `useForwardFlow` (44 KB) e companhia sem mexer em render nem em scroll.
- **Fase 2 — baixo risco.** `manualChunks` hoje só separa `node_modules`; adicionar regras para
  `src/conversa/orcamento/**` e `src/conversa/components/*Modal*` garante que esses pedaços não
  voltem para o chunk principal por *code splitting* oportunista do Rollup.
- **Fase 3 — NÃO fazer junto com as outras.** `conversaOutboundMediaMerge.js` (104 KB) é o maior
  ganho isolado, mas está no caminho do **envio otimista** (bolha otimista → HTTP → reconcile por
  `tempId`/`client_temp_id` → outbox → watchdog), que o `CLAUDE.md` do frontend marca como zona de
  perigo. Merece sessão própria, com teste de envio de mídia offline/reconexão.

**Como medir (não rodei build nesta sessão):** `npm run build` e comparar o tamanho de
`dist/assets/ConversaView-*.js` antes/depois de cada fase; os KB da tabela acima são **tamanho de
fonte**, não do bundle. Os Playwright de conversa + envio de mídia são o portão de regressão.

---

## 4. Riscos residuais do que foi alterado

1. **Emit com status não gravado.** Quando o ACK já avançou a linha, `gravarResultadoDoEnvio`
   preserva o status no banco, mas os controllers continuam emitindo `status_mensagem` com o
   `nextStatus` do envio. A tela pode mostrar um tique a menos até o próximo ACK ou refetch.
   É estritamente melhor que antes (o banco regredia de forma **permanente**), mas suprimir esse
   emit no caso `jaAvancada` seria mudança de comportamento de socket — ficou de fora de propósito.
2. **Finalização manual com exceção de transporte agora deixa bolha `pending`.** Antes, se
   `provider.sendText` estourasse, nenhuma linha era inserida — e se a mensagem tivesse saído, o
   operador não via nada. Agora a linha existe (`pending`) e a varredura resolve. É o
   comportamento do envio normal, mas é visível ao usuário.
3. **Finalização por ausência continua sem `referenceId`.** Não reordenei ali porque o código
   depende de **não** inserir linha quando a recusa é definitiva (comentário em
   `absenceFinalizationService.js:~489`: a bolha de ausência como última mensagem fazia a conversa
   voltar para "em atendimento" para sempre). Então a varredura ainda pode reenviar essa mensagem.
   Corrigir exige inserir-antes-e-apagar-na-recusa → **é proposta, não fiz**.
4. **Instância obsoleta por até 15 s** se alguém alterar `whatsapp_instances` **fora** da API (SQL
   direto). Mudança pela API invalida na hora.
5. **Fila de mídia em vez de paralelismo.** Com rajada grande, a última mídia da fila demora mais a
   aparecer. Nada é descartado e a ordem é preservada; `INBOUND_MEDIA_DOWNLOAD_CONCURRENCY` sobe se
   necessário.
6. **`sendVoice` transitório não tenta mais `/messages/audio`.** Se algum dia a UltraMSG passar a
   responder 5xx para "formato recusado", esses áudios ficariam `pending` em vez de sair pelo
   fallback. O log `[ULTRAMSG][VOICE] falha transitória — fallback … NÃO executado` serve de alarme.
7. **ACK de grupo mantém a heurística antiga.** JID `@g.us` não tem telefone extraível, então o
   fallback 3 segue como era para grupos.

## 5. Como testar à mão (depois do deploy)

| O quê | Como | Esperado |
|---|---|---|
| Status não regride | Enviar texto; no mesmo segundo o ACK `delivered` chega. `SELECT status FROM mensagens ORDER BY id DESC LIMIT 1` | `delivered` (nunca volta a `pending`/`sent`); `whatsapp_id` preenchido |
| Áudio não duplica | Gravar e enviar áudio de voz com a UltraMSG instável (ou 5xx forçado) | **um** áudio no WhatsApp; bolha em relógio; log de fallback não executado |
| Finalização rastreável | Encerrar conversa com mensagem de finalização ligada. `SELECT referenceId` no log do provedor + `provider_queue_id` na linha | POST com `crm-{id}`; coluna preenchida; **uma** bolha |
| Cache de instância | Enviar 5 mensagens seguidas; contar `GET whatsapp_instances` no log do Supabase | 1 leitura por TTL, não 5+ |
| Token novo vale na hora | Alterar o token da instância na tela de integração e enviar | envio usa o token novo imediatamente |
| Teto de mídia | Mandar 10 fotos de uma vez do celular | no máximo 3 downloads simultâneos; as 10 chegam |
| Sem órfão | Encaminhar vídeo e imagem; `ls uploads \| grep -- -wa\.` | nenhum arquivo novo `-wa.*` |
| 422 de áudio | Enviar áudio em formato que a conversão recusa | 422 na tela e **nenhum** arquivo novo em `uploads/` |
| ACK na conversa certa | Dois contatos com envio pendente ao mesmo tempo; ACK de um | tique só na conversa dona do número |

## 6. Para a próxima IA

- Suíte: `npm test` no `backend/` — **278 suítes / 3604 testes** é o novo baseline.
- Testes desta sessão: `statusNaoRegrideNosEnvios`, `sendVoiceFallbackDefinitivo`,
  `finalizacaoReferenceId`, `inboundCacheEDedup`, `midiaConcorrenciaEOrfaos`,
  `ackCorrelacaoEntreConversas`. Cada um foi verificado a falhar com o código antigo.
- Para cache de leitura novo, use `helpers/shortTtlCache` (não escreva outro `Map` com TTL à mão) e
  respeite os invariantes de §2.
- Para trabalho em segundo plano que leia/escreva arquivo ou chame rede por mensagem, use
  `helpers/limiteConcorrencia`.
