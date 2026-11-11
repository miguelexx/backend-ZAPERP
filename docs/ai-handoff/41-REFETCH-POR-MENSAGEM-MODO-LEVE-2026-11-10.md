# 41 — "Fica lento quando há fluxo de mensagens": o refetch por mensagem e o modo leve (10/11/2026)

> Sessão de 2026-11-10 · backend `master` + frontend `main` · **nada commitado, nada pushado, nenhuma migration**.
> Sintoma relatado: com fluxo de mensagens/conversas o sistema inteiro fica lento.
> Baseline antes: backend **278 suítes / 3604 testes**, frontend `test:node` **59/59**.
> Depois: backend ver §6, frontend **60/60**.

---

## 0. Resumo em uma frase

Cada mensagem recebida fazia **todo usuário que podia ver a conversa** baixar o **detalhe completo**
dela (`GET /chats/:id`: histórico, movimentações, citações, sync do contato com o provedor) **e marcar
a conversa como lida para si** — por causa de um sinal de socket (`atualizar_conversa`) cujo único
propósito era "vá buscar", emitido logo antes de outro evento (`conversa_atualizada`) que já levava o
card inteiro. Com 10 atendentes e 1 mensagem/s, era o endpoint mais pesado da API rodando 10×/s,
mais 10 UPDATEs em `conversa_unreads` por mensagem. Agora o sinal vem marcado com
`motivo: 'nova_mensagem'`, o frontend não refaz o GET para conversa que já tem na lista, e os
refetches de card que sobram usam um **modo leve** sem efeitos colaterais.

## 1. A cadeia, como estava (medida no código, não em produção)

Por mensagem recebida (`webhookZapiController.receberZapi`, bloco "4) Realtime"):

| Emit (escopado a quem pode ver) | O que o frontend fazia |
|---|---|
| `nova_mensagem` | preview + bump do card; `addChatIfAuthorized` (GET) se o card não estava na lista |
| `atualizar_conversa { id }` | debounce 180 ms → **`GET /chats/:id` completo** → `updateChat`/`addChat` |
| `conversa_atualizada { card completo }` | merge do card (status, setor, atendente, nome, foto, preview) — **sem GET** |

O `GET /chats/:id` (`conversationDetailController.detalharChat`) é a abertura da thread: página de
mensagens com todas as colunas, `marcarComoLidaPorUsuario` (**UPDATE em `conversa_unreads` e em
`conversas.lida`**), `mensagens_ocultas`, movimentações internas (admin/supervisor), `enrichReplyMetaSnippets`,
`enrichMensagensComAutorUsuario`, e um `setImmediate` que chama `syncConversationContactOnJoin`
(provedor). Oito a dez idas ao banco por chamada.

**O efeito colateral que ninguém pediu:** a marcação de leitura. Quem **está** com a thread aberta
marca pelo socket (`marcar_conversa_lida`, em `index.js:255`), não por este GET. Quem **não** está
olhando também era marcado — o contador do servidor voltava a zero ~0,6 s depois de `incrementarUnreadParaConversa`
o ter incrementado, antes de o snapshot de não lidas (`GET /chats/counts?unread=1`, debounce de 1 s
no frontend) ser lido. **Isso explica badges de não lida que "somem sozinhos"**, diagnosticados em
29/09 como truncamento de 1000 linhas (doc 29 §1 item 3): aquele era um dos motivos; este é o outro.

O chatbot tinha a mesma cadeia **sem escopo** (`chatbotRealtimeEmitter.emitBotMensagemRealtime`
emitia para `empresa_` inteira): cada resposta da triagem fazia **todo usuário da empresa** que não
tinha a conversa na lista pedir o detalhe e levar 403.

## 2. O que FOI alterado

### Backend (não deployado)

| # | Arquivo | Mudança |
|---|---|---|
| 1 | `controllers/webhookZapiController.js` (bloco "4) Realtime", 2 emits + fallback por departamento) | `atualizar_conversa` do inbound leva `{ id, motivo: 'nova_mensagem' }`. Frontend antigo ignora o campo e continua como antes. |
| 2 | `helpers/chatbotRealtimeEmitter.js` | `emitBotMensagemRealtime` passa a usar `emitirParaUsuariosQuePodemVerConversa` (mesmo caminho do inbound) para os 3 eventos; só cai nas rooms amplas de antes se não houver destinatários ou se o serviço de visibilidade falhar. `atualizar_conversa` com o mesmo `motivo`. O require do gateway é **lazy** (evita ciclo no boot e mantém `jest.doMock` dos testes existentes). |
| 3 | `controllers/chat/conversationDetailController.js` | **Modo leve `?lista=1`**: 1 mensagem (preview), **não** marca como lida, sem `mensagens_ocultas`, sem movimentações internas, sem `enrichReplyMetaSnippets`, sem sync em background. Permissões (403) idênticas. Sem o parâmetro, byte a byte como antes. |

Sem migration, sem rota nova, sem variável de ambiente. Contrato de socket: **só um campo aditivo**.

### Frontend (não deployado)

| # | Arquivo | Mudança |
|---|---|---|
| 1 | **novo** `src/socket/atualizarConversaPolicy.js` | Política pura do handler: lote só de `nova_mensagem` + card na lista → **ignorar**; + card fora da lista → `addChatIfAuthorized`; qualquer sinal sem o motivo (assumir, transferir, backend antigo…) → refetch como sempre. Lote misto na mesma janela nunca engole o sinal explícito. |
| 2 | `src/socket/socket.js` | Handler acumula os sinais por conversa na janela de debounce e decide pela política; refetch partilha requisição em voo (`createInFlightDeduper`); **403/404 só pede `GET /chats` se o card estava na lista** (antes todo usuário da empresa recarregava lista + contadores a cada assumir/transferir de conversa alheia); `addChatIfAuthorized` e o refetch usam `fetchChatById(id, { lista: true })`. |
| 3 | `src/chats/chatService.js` | `fetchChatById(id, { lista })` → `GET /chats/:id?lista=1`. A abertura da thread (`conversaService.getChatById`) **não** muda. |
| 4 | `src/chats/hooks/useChatListResync.js` | Com a aba **oculta**, a reconciliação (`GET /chats` + `/chats/counts`) fica pendente e sai de uma vez no `visibilitychange`; o poll de 5 min também. Os patches do socket continuam a aplicar na store. |

## 3. Por que é seguro

- **Compatível nos dois sentidos de deploy.** Backend novo + frontend antigo: o frontend ignora
  `motivo` e `?lista` não é enviado → igual a hoje. Frontend novo + backend antigo: sem `motivo` a
  política devolve `refetch` em tudo e o backend ignora `?lista=1` → igual a hoje. O ganho só aparece
  com os dois no ar.
- **Nada que o card precisa deixou de chegar.** O `conversa_atualizada` do inbound já levava
  `status_atendimento`, `departamento_id` (quando há setor), `atendente_id`, nome, foto,
  `exibir_badge_aberta`, `modo_simples_aguardando` e `ultima_mensagem_preview`; `nova_mensagem` já
  atualizava preview/thread. O refetch só repetia isso.
- **Conversa fora da lista continua a aparecer**: `nova_mensagem` → `addChatIfAuthorized`, e a
  política também manda para lá. É um GET (leve) autorizado — nunca row inventada a partir do socket.
- **Modo leve devolve `mensagens: [última]`**: a lista deriva preview/direção de `chat.mensagens[0]`
  em `chatListRowAtendimento.js` (`getLastMessage`, `pickListaUltimaMensagem`), então a linha única
  preserva esse caminho.
- **A thread aberta continua a marcar leitura** pelo socket (`carregarConversa` e o handler de
  `nova_mensagem` emitem `marcar_conversa_lida`). O modo leve só retira a marcação de quem não abriu.
- **Visibilidade do bot**: o escopo usa o mesmo cache de 15 s do inbound. Se o bot acabou de mudar
  o setor nesta mesma mensagem, quem ganhou o setor recebe `emitirMudancaSetorRealtime` logo a seguir
  (já existia) e busca o card com as mensagens do bot incluídas.

## 4. O que muda para o usuário (comportamento, não só custo)

- **Badges de não lida passam a persistir** para quem não abriu a conversa. É o comportamento
  correto, mas é visível: equipes habituadas a "o badge some sozinho" vão ver mais badges.
- Lista e chips de uma aba em segundo plano só atualizam ao voltar para ela (instantâneo, de uma vez).
- Nenhuma mudança no que a thread mostra, na ordem, nos tiques ou no envio.

## 5. Como testar à mão (depois dos dois deploys)

| O quê | Como | Esperado |
|---|---|---|
| Fim do refetch por mensagem | 2 abas (admin + atendente que vê a conversa), Network filtrando `/chats/`; mandar 10 mensagens do celular para a mesma conversa | **zero** `GET /chats/:id` em ambas as abas (a conversa já está na lista); cards atualizam pelo socket |
| Conversa nova aparece | mensagem de um número sem conversa carregada | 1 `GET /chats/:id?lista=1` por aba e o card entra |
| Badge persiste | mensagem para conversa que ninguém abriu | badge aparece e **fica**; `SELECT unread_count FROM conversa_unreads WHERE conversa_id=…` > 0 para cada usuário visível |
| Thread aberta marca leitura | abrir a conversa e receber mensagem | `mensagens_lidas` no socket; `unread_count` do usuário volta a 0 |
| Bot escopado | nova conversa cai na triagem; aba de usuário de OUTRO setor com Network aberto | nenhum `GET /chats/:id` (antes: 403) |
| Assumir/transferir | atendente A assume conversa que B não vê | aba de B: 1 `GET /chats/:id?lista=1` → 403, **sem** `GET /chats` em seguida |
| Aba oculta | minimizar a aba durante fluxo; voltar | nenhum `GET /chats` enquanto oculta; um `GET /chats` + `/chats/counts` ao voltar |

## 6. Testes

- Backend novos: `tests/detalharChatModoLista.test.js` (3), `tests/chatbotRealtimeEmitterEscopo.test.js` (3);
  `tests/receberZapiInbound.test.js` passou a asseverar o `motivo` no payload.
- Frontend novo: `scripts/test-atualizar-conversa-policy.mjs` (no `test:node`), validado com 3 mutações:
  `ignorar`→`refetch` no caso 1, não marcar `refetchExplicito` sem motivo, e 403 sem row devolvendo true.
- Resultado da suíte completa: registrado no relatório da sessão.

## 7. O que ficou de fora, com motivo

- **`emitirSincronizacaoListaConversas` continua em `empresa_`** (assumir/transferir/encerrar/ausência).
  É o que faz quem **perdeu** visibilidade tirar o card da lista (o emit escopado não os alcança).
  Custo agora: 1 GET leve com 403 por usuário por ação, sem resync de lista. Escopar exigiria emitir
  para "visíveis antes ∪ visíveis depois" — proposta, não feita.
- **`GET /chats` de reconciliação (6 eventos / 5 s por aba ativa)** continua como em 09/09; só pausa
  em aba oculta.
- **`/chats/counts` — FEITO na mesma data (10/11, não deployado)**, em `services/chatListCountsService.js`:
  (1) **coalescing** — a promessa em voo fica guardada na entrada do cache (`{ promise }`, mesmo padrão
  de `supervisaoService` e `shortTtlCache`), então N chamadas concorrentes com a mesma chave
  (`company_id:user_id:filtros` — duas abas do mesmo usuário, flushes de abas diferentes no mesmo
  segundo) rodam as ~14 counts UMA vez; falha (timeout/banco) não é cacheada, a entrada em voo sai no
  catch. (2) **TTL configurável**: `CHAT_COUNTS_CACHE_TTL_MS` (default **20 s**; era 10 s fixo). Formato
  da resposta intacto. Conferido quem invalida: **só** `usuarioWhatsappInstanceAccessController`
  (visibilidade por número) chama `invalidateCountsCache`; assumir/transferir/encerrar/finalização
  automática **não** invalidam — nunca invalidaram — e o chip de quem fez a ação muda por delta otimista
  no frontend (`chatList.jsx`), então o TTL maior só alarga a defasagem para quem **não** fez a ação,
  que já era de até 10 s. Teste: `tests/chatListCountsCache.test.js` (coalescing, isolamento por
  empresa, falha não cacheada, TTL da env; cada caso conferido a falhar com a mutação correspondente).
- **Leituras de CONFIGURAÇÃO por chamada de `GET /chats` / `GET /chats/:id` — FEITO 11/11 (não
  deployado).** Quatro leituras que rodavam em TODA chamada e só mudam quando o admin salva algo
  passaram a `helpers/shortTtlCache` com chave por `company_id` (invariantes do doc 40 §2: tenant na
  chave, falha não cacheada, coalescing, teto + varredura): (1) `empresaModoSimplesAtivo`
  (`empresas.atendimento_modo_simples`, 11 chamadores — lista, detalhe, contadores, envio,
  supervisão, webhook) TTL 30 s, invalidado em `configController.putEmpresa` (único sítio que grava a
  flag); (2) `obterDepartamentoIdsFinanceiro` (lia `departamentos` inteira só para saber se o usuário
  é do Financeiro) TTL 60 s, invalidado em `controllers/dashboard/departamentos.js` (criar/renomear/
  excluir) e nos departamentos padrão de `chatbotAutoConfigService.generateChatbotConfig` (um deles é
  "Financeiro"); (3) `isAlertaSemRespostaAtivo` (lia `ia_config.config` inteiro por página) TTL 30 s,
  invalidado em `saveAlertaSemRespostaConfig` e também onde `config` é regravado inteiro
  (`iaController.putConfig`, `configureChatbotForCompany`/`toggleChatbotForCompany`); (4) a closure
  `loadColaboradoresEncaminhar` da lista virou `helpers/colaboradoresEncaminharHelper.js` —
  a chave NÃO inclui `user_id`: a lista COMPLETA de `usuarios` ativos fica no cache e o
  `neq('id', user_id)` original é aplicado em memória (N usuários da empresa partilham uma consulta;
  cada chamador recebe cópias), TTL 60 s, invalidado em `userController` criar/atualizar/excluir.
  Nos quatro, erro do banco devolve o fallback de sempre (`false`/`[]`/exceção na flag) **sem**
  gravar no cache, e a resposta HTTP não muda em nada (o teste compara corpo e headers da chamada
  fria com a quente). TTLs por env, todas opcionais: `EMPRESA_MODO_SIMPLES_CACHE_TTL_MS`,
  `FINANCEIRO_SETOR_CACHE_TTL_MS`, `ALERTA_SEM_RESPOSTA_CACHE_TTL_MS`,
  `COLABORADORES_ENCAMINHAR_CACHE_TTL_MS`. **Medição** (`tests/chatsConfigCacheQueries.test.js`,
  contando `supabase.from` no mock; atendente com 1 conversa visível e
  `incluir_colaboradores_encaminhar=1`): `GET /chats` **15 → 11 queries** por página (−4: `departamentos`,
  `usuarios`, `ia_config` e uma das duas leituras de `empresas`); `GET /chats/:id` **7 → 5** por
  abertura (−2: `empresas`, `ia_config`). Em regime (dentro do TTL) só a 1ª chamada da empresa paga
  as quatro. Testes: `tests/configLeiturasCachePorEmpresa.test.js` (19 casos — cache por empresa sem
  vazar entre empresas, falha não cacheada, formato/ordem de antes, cada mutador invalida a empresa
  certa e só ela; cada caso conferido a falhar com a mutação correspondente — ver o relatório da
  sessão). `tests/setup.js` limpa os quatro caches antes de cada teste, senão um `maybeSingle`
  mockado com valor novo seria ignorado por um TTL inteiro.
- **Pipeline do inbound (~20–30 round-trips por mensagem)**: ver doc 40 §1.3 — as releituras são
  correção de bug, não dá para memoizar.
- **Chunk `ConversaView` (436 KB)**: doc 40 §3.8, fase 1 — é boot, não fluxo; sessão própria.
- **DROP de índices mortos + `VACUUM (ANALYZE) conversas`**: SQL pronto no doc 40 §3.5, roda o Miguel.

## 8. Contadores sem teto: `conversas.tem_mensagem` (11/11/2026 — **migration NÃO aplicada**, nada deployado)

Fecha o doc 40 §3.3. Os chips **Abertas**, **Minha fila** e **Em atendimento** (e o `total_count` da
lista nessas abas, que usa o mesmo `countConversasWithFilter`) eram contados varrendo até
`CHAT_FILTER_ID_LIMIT` (2000) linhas de `conversas` com embed `mensagens(id)`, filtrando em JS
(`rowVisibleInPostFilteredList`) e **parando no teto** — acima dele o badge mostrava menos que o real.
A empresa 1 já tem 1524 conversas em "Todas". O único dado que obrigava o embed era "a conversa tem
mensagem?"; denormalizado em `conversas.tem_mensagem`, as três regras viram SQL e o contador volta a
ser `count(*)` exato.

### ⚠️ ORDEM OBRIGATÓRIA (anti-padrão 14) — a migration vem ANTES do deploy

| Passo | O quê | Observação |
|---|---|---|
| 1 | `supabase/migrations/20261111135500_conversas_tem_mensagem.sql` — coluna (default `false`) | rápido |
| 2 | backfill em lotes de 5000 com `FOR UPDATE SKIP LOCKED` — **repetir o UPDATE até `UPDATE 0`**, depois a query de conferência tem de devolver 0 | um comando por vez, **nunca** todos os lotes num BEGIN/COMMIT |
| 3 | função + trigger `AFTER INSERT ON mensagens` (condicional: só faz UPDATE enquanto `tem_mensagem = false`) | só depois do passo 2 zerar |
| 4 | índice parcial `idx_conversas_company_tem_mensagem` | `CREATE INDEX CONCURRENTLY` **sozinho num run, fora de transação**; o SQL Editor envolve o que se cola numa transação e recusa com 25001 (medido em 23/10, migration 20261023180000) — nesse caso usar a versão comum (4b no arquivo; ~32 mil linhas, milissegundos) |
| 5 | deploy do backend + restart | o código tolera a coluna ausente, mas só conta certo com 1–3 aplicados |

Se o deploy sair **antes** da migration, nada quebra: a 1ª contagem recebe 42703, o processo loga
**um** aviso `[conversas] coluna tem_mensagem ausente — rode a migration …` e todas as próximas vão
direto pelo caminho antigo (varredura + teto), idêntico ao de hoje. Depois da migration é preciso
**reiniciar** (a ausência é lembrada por processo — `helpers/conversasTemMensagemColumn.js`, mesmo
padrão de `ackMilestoneColumns.js`).

### O que mudou no código (`services/chatListCountsService.js`)

- `buildPostListRulesSqlOr(ctx, overrides)` — tradução 1:1 de `rowVisibleInPostFilteredList` para a
  sintaxe `or=` do PostgREST, para os três overrides. A JS continua sendo a regra de referência e o
  fallback; **mantenha as duas espelhadas**. Exemplo (Abertas):
  `tipo.eq.grupo,and(or(tipo.is.null,tipo.neq.grupo),aguardando_resposta_campanha.not.is.true,status_atendimento.eq.aberta,or(tem_mensagem.eq.true,atendente_id.not.is.null))`.
- `countConversasWithPostListRules` — com a coluna: `select('id', {count:'exact', head:true})` +
  `applyChatListSqlFilters` + `.or(predicado)`; 42703 mencionando `tem_mensagem` → `desligarTemMensagem()`
  e cai em `countConversasWithPostListRulesVarrendo` (o loop antigo, renomeado, sem alteração). Qualquer
  outro erro propaga como antes (o `withTimeout` do `/chats/counts` continua por cima).
- Formato de resposta de `/chats/counts` e do `total_count` da lista: **intacto**.
- "Em atendimento" nunca dependeu de `tem_mensagem` (status + vínculo), mas varria junto; agora também
  é `count(*)`. Fica gated pela mesma flag só para o caminho "coluna ausente" ser idêntico ao atual.

### Decisões e limites

- **Lista (`conversationListController`) — NÃO usa a coluna, de propósito.** A lista já embute
  `mensagens(limit 1)` para o preview, então `sem_mensagens`/`exibir_badge_aberta` saem de graça do que
  já vem. Os dois pós-filtros candidatos mudariam semântica: (a) "fechadas e vazias sem atendimento"
  isenta quem tem linha em `atendimentos` (dado que não está em `conversas`, não vira SQL puro) e
  (b) mover "Abertas"/"Minha fila" para o SQL faria a página vir cheia em vez de encurtada pelo
  pós-filtro — melhoria, mas altera paginação. Além disso `tem_mensagem` **nunca volta a `false`**
  (limpar/apagar mensagens não é coberto), enquanto o embed reflete o estado real; usar os dois na
  mesma tela faria o badge `sem_mensagens` divergir do filtro. Se um dia a lista for para a coluna,
  o trigger precisa de par em `AFTER DELETE` primeiro.
- Comparações no SQL são exatas (`tipo.eq.grupo`, `status_atendimento.eq.aberta`); a JS normaliza com
  trim/lowercase. É a mesma premissa que `applyChatListSqlFilters` já assume — o código grava esses
  valores em minúsculas.
- `aguardando_resposta_campanha.not.is.true` é redundante com o `.eq('aguardando_resposta_campanha', false)`
  que `applyChatListSqlFilters` já aplica em Abertas/Minha fila; ficou para o predicado ser uma
  tradução fiel e não depender da ordem dos filtros.

### Testes

`tests/chatListCountsTemMensagem.test.js` (18 casos, mock do Supabase que grava a cadeia de chamadas):
(a) coluna presente — 1 query head count, sem `mensagens` no select, sem `.range`, predicado no `.or`,
devolve o count do banco (4321 > 2000); (b) coluna ausente — 42703 na 1ª → varredura com embed +
`range(0, 999)` + regras JS, 1 aviso, 2ª chamada nem tenta o count; religar + coluna de volta → count;
(c) timeout 57014 e 42703 de OUTRA coluna propagam e não desligam a flag; (d) a varredura antiga continua
parando no teto (2500 elegíveis → 2000 em 2 páginas); (e) predicado caso a caso (admin, atendente com
participação, `atendente_id` na query, sem `user_id`, grupos fixados). Mutações conferidas a derrubar o
caso certo: sem `.or(predicado)`; nunca usar o count; não lembrar a ausência; engolir todo erro; tirar o
teto da varredura; Abertas sem a condição de campanha; atendente tratado como admin.

### Como testar à mão (depois da migration + deploy)

1. Admin da empresa 1, aba Abertas: o chip tem de bater com `SELECT count(*) FROM conversas WHERE
   company_id = 1 AND (tipo = 'grupo' OR (status_atendimento = 'aberta' AND aguardando_resposta_campanha
   IS NOT TRUE AND (tem_mensagem OR atendente_id IS NOT NULL)))` — e, se passar de 2000, continuar
   batendo (antes travava em 2000).
2. Log do PM2 logo após o restart: **não** pode aparecer `coluna tem_mensagem ausente`. Se aparecer,
   a migration não está no banco certo — a API continua funcionando pelo caminho antigo.
3. Receber uma mensagem numa conversa nova e conferir `tem_mensagem = true` nela (trigger).

## 8. Revisão independente de 11/11/2026 (dois revisores, 0 bloqueantes) — o que foi ajustado

**Backend.** (1) `helpers/shortTtlCache.js` e `services/chatListCountsService.js`: uma invalidação que
corria ENQUANTO o loader estava em voo era perdida — o resultado antigo era regravado por um TTL inteiro
(admin salva a configuração 20 ms depois de um GET começar). Agora só recacheia se a entrada em voo ainda
é a própria (`store.get(k)?.promise === promise`). Testes: `cacheInvalidacaoEmVoo`, `countsInvalidacaoEmVoo`.
(2) `webhookZapiController.js`: log de erro do DeliveryCallback com 12 dígitos do telefone → `telefoneParaLog`.
(3) A flag `WHATSAPP_DEBUG` era lida no load em `webhookZapiController.js` e `fromMeReceivedReconcile.js`
(com `=1` nunca ligava lá); agora é `whatsappDebugAtivo()` em todo sítio. (4) Modo lista não aplica o filtro
de movimentação legada à única linha buscada (o embed do GET /chats também não) — `exibir_badge_aberta` fica
coerente com a lista. Nota do revisor mantida como está: o trigger de `tem_mensagem` exige `company_id` na
linha de `mensagens`; todos os INSERTs atuais passam a coluna.

**Frontend** (ver 12-PERFORMANCE): refetch explícito com GET em voo espera e refaz UM GET (a resposta em voo
pode ser anterior ao sinal: assumir→transferir); `lazyHookImpl` não recarrega a aba quando o `import()` falha
OFFLINE; `usePixConfig` devolve `pixActionBusy` quando `withImpl` está "gated". Aceite consciente: 403/404
sem a conversa na lista não refresca os chips (até o próximo flush ou o poll de 5 min).
