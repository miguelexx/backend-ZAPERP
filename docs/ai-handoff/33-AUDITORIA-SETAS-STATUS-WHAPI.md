# 33 — Auditoria pesada: setas de status (ACK) da Whapi

> 2026-10-16 · auditoria de leitura, **nenhuma linha de código alterada**.
> Escopo: todo o caminho que decide o ✓ / ✓✓ / ✓✓ azul de uma mensagem enviada por canal Whapi —
> do POST do provedor até o pixel na bolha e no card da lista.
> Suítes rodadas: `messageStatusHelper`, `statusZapiAckTardio`, `statusZapiWhapiFailedAck`,
> `webhookStatusApply`, `whapiWebhook`, `ultramsgStatusHelper` → **56/56 passam**.

---

## 1. O caminho auditado (ponta a ponta)

```
Whapi POST /webhooks/whapi  { channel_id, statuses: [ { id, code, status, recipient_id, timestamp } ] }
  │
  ├─ webhookLogger('whapi')
  ├─ webhookBodyResolver
  ├─ requireWhapiWebhookToken      ← fail-closed, SÓ header (X-Webhook-Token | Bearer), timing-safe
  ├─ resolveWhapiWebhookCompany    ← channel_id → whatsapp_instances → company_id (+ cache 30s)
  │                                   injeta req.webhookContext + alias req.zapiContext
  └─ webhookWhapiController.handleWebhookWhapi
       └─ para cada s em statuses[]:
            normalizeWhapiStatusToInternal(s)   ← mapWhapiAckToStatus(status, code)
            dispatchOne(statusZapi, req, body)  ← req.body mutado, await completo por item
                 │
                 ├─ cap de grupo (read/played → delivered)
                 ├─ resolveAckEffectiveStatus(atual, novo)   ← guarda anti-regressão
                 ├─ UPDATE mensagens (1 → 1b → 2 → 4 → 4b; 3/3b bloqueados p/ Whapi)
                 ├─ não achou → agendarAckTardio (800ms / 2,5s / 7s, máx. 150 em memória)
                 ├─ io.emit('status_mensagem') → empresa_N + conversa_N + usuario_N
                 └─ disparoWebhookHook.aplicarStatusDisparoFromWebhook
                          │
Frontend: socket.on('status_mensagem') → enqueueStatusMensagemEvent (fila 75ms, merge por rank)
            → conversaStore.patchMensagem (pickHigherStatus, monotônico)   → bolha
            → chatsStore.setUltimaMensagem (sem guarda)                     → card da lista
            → resolveOutgoingTick / ChatTicks                               → ✓ ✓✓ ✓✓azul
Rede de segurança: pendingOutboundReconciliationService (pending/sending + sent + erro-com-id)
```

## 2. O que foi CERTIFICADO correto (com evidência)

| # | Invariante | Evidência |
|---|-----------|-----------|
| 1 | **Auth fail-closed.** Sem `WHATSAPP_WEBHOOK_TOKEN` → 500; token só em header; **nunca** `?token=`; sem fallback por instanceId; comparação timing-safe com checagem de comprimento fora do compare | `middleware/requireWhapiWebhookToken.js`; `tests/whapiWebhookToken.test.js` |
| 2 | **Tenant nunca vem do payload.** `company_id` e `whatsapp_instance_id` saem da instância resolvida pelo `channel_id`; cache só guarda sucesso, chave = channel_id exato (impossível cruzar tenant); erro de banco → 500 (reentrega), canal não mapeado → 200 | `resolveWhapiWebhookCompany.js`; `tests/resolveWhapiWebhookCompanyCache.test.js` |
| 3 | **Todo UPDATE de status filtra `company_id`.** Os fallbacks "relaxados" só soltam o filtro de *instância*, nunca o de empresa. `whatsapp_id` ambíguo (2 linhas, conversas diferentes) → atualização **bloqueada** e logada | `whatsappIdLookup.js` (`selectSingleMensagemByWhatsappId`, `logAmbiguousWhatsappId`) |
| 4 | **Anti-regressão completa.** Matriz 6×6 executada: nenhum ACK atrasado rebaixa o tique; `erro` só aplica sobre `pending`/`erro`; sucesso posterior **cura** `erro`; `played` é terminal | tabela no §3 abaixo |
| 5 | **Escala `code` da Whapi correta.** `0=failed, 1=pending, 2=sent, 3=delivered, 4=read, 5=played, 6=deleted` — bate com o único ponto confirmado na doc oficial (`code: 4` + `status: "read"`, doc 25 §linha 185) e com a ordem do enum de `status`. `code` desconhecido (7) cai na string | §3 abaixo; `docs/ai-handoff/25-WHAPI-SEGUNDA-INTEGRACAO.md:185,205` |
| 6 | **Status desconhecido é ignorado, não gravado.** `status:'queued'` sem code → `statusNorm = null` → 200 sem tocar o banco. Nunca escreve lixo na coluna | §3, linha `queued` |
| 7 | **Grupos nunca mostram azul.** Cap `read`/`played` → `delivered` no webhook (consulta `conversas.tipo`/`telefone` com `company_id`), e o frontend zera `isRead` para grupo **nas duas** telas (bolha e card) | `statusZapi.js`; `bubbleStatus.js:142`; `ChatListRow.jsx:488` |
| 8 | **Heurística UltraMSG desligada p/ Whapi.** Fallbacks 3/3b ("a única pendente recente", "casa pelo telefone") estão atrás de `ehCanalWhapi === false` — id Whapi tem `_` e cairia neles por acidente | `statusZapi.js` (gate por provedor; doc 25, parte 4, item 13) |
| 9 | **Corrida do ACK adiantado coberta.** ACK que chega antes do `whatsapp_id` ser gravado é guardado e reaplicado por match **exato** (800ms/2,5s/7s), teto 150, timers `unref()`, desligado em teste | `statusZapi._ackTardio`; `tests/statusZapiAckTardio.test.js` |
| 10 | **Reentrega / backlog é inofensiva.** Whapi reentrega statuses antigos no reconnect; sem guarda de idade, mas a guarda de rank torna todo reenvio idempotente (no-op) | §3 (diagonal da matriz) |
| 11 | **Varredura não rebaixa tique no banco.** `statusJaMaisAvancado` relê status/status_mensagem imediatamente antes de gravar; ação `keep_status_mais_avancado` | `pendingOutboundReconciliationService.js:203` |
| 12 | **Rede de segurança para ACK perdido existe.** Para canal Whapi a varredura reexamina `sent` (GET `/messages/{id}` devolve `status` atual → sobe para delivered/read) e `erro`-com-id | idem `:1203`, `:1212` |
| 13 | **Frontend monotônico na bolha.** Fila de 75ms com merge pelo maior rank; `pickHigherStatus` no patch; `erro` perde para sent/delivered/read (envio recuperado sai do vermelho) e vence pending/indefinido; numéricos e dialetos pt (`entregue`,`lida`,`visualizada`) normalizados | `statusMensagemBatch.js`; `conversaStore.js:205-219` |
| 14 | **`erro` nunca é mascarado na UI** — decisão de 15/10 mantida e comentada no código (esconder trocaria alarme falso por falha silenciosa) | `bubbleStatus.js` |

## 3. Evidência executada (tabelas reais, não leitura)

Script rodado contra os módulos reais (`mapWhapiAckToStatus` → `normalizeWhapiStatusToInternal` →
`normalizeMessageAckStatus` → `resolveAckEffectiveStatus` → `canonStatusForEmit`):

**Escala Whapi (`code` presente) — 11 strings × 11 codes:**

| code | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 (desconhecido) |
|------|---|---|---|---|---|---|---|---|
| → interno | `erro` | `pending` | `sent` | `delivered` | `read` | `played` | `erro` | cai na string |

**Matriz de não-regressão (`resolveAckEffectiveStatus(atual, ack)`):**

| atual \ ack | pending | sent | delivered | read | played | erro |
|---|---|---|---|---|---|---|
| **pending** | pending | sent | delivered | read | played | **erro** |
| **sent** | sent | sent | delivered | read | played | sent |
| **delivered** | delivered | delivered | delivered | read | played | delivered |
| **read** | read | read | read | read | played | read |
| **played** | played | played | played | played | played | played |
| **erro** | pending | sent | delivered | read | played | erro |

Nenhuma célula rebaixa. `erro` entra apenas na 1ª e na última linha — exatamente a regra documentada.

---

## 4. ACHADOS

Nenhum deles é "a seta está errada hoje". A implementação está correta no caminho feliz e nos
cenários conhecidos. São 1 risco de segurança real e 9 pontos de fragilidade/dívida, em ordem.

### F1 — SEGURANÇA: o segredo que protege o webhook Whapi vai para os logs pela rota UltraMSG · ✅ CORRIGIDO (§6)

`requireWhapiWebhookToken` usa `process.env.WHATSAPP_WEBHOOK_TOKEN`. **O mesmo segredo** é aceito
por `requireWebhookToken` (UltraMSG) em `req.query.token` (`middleware/requireWebhookToken.js:54`),
e `middleware/logger.js:7` loga `req.originalUrl` de toda requisição. A vuln do log já é conhecida
(`CLAUDE.md` → "Vulnerabilidades ativas"), mas a consequência **para a Whapi** não estava escrita:
o único credencial do webhook Whapi está escrito em claro no log de acesso, junto com o
`channel_id` (logado por `_logSafe`).

Quem tiver leitura de log pode forjar `statuses[]` — e `messages[]` — para **qualquer** canal de
**qualquer** empresa. No caso das setas o dano é cosmético (virar um tique); no caso de `messages[]`
é injeção de mensagem.
A doc 25 (§211) registra que o canal real `NEBULA-AER3B` ainda estava configurado apontando para
`/webhooks/ultramsg?token=…` — isto é, o token circulou em query string em produção.

**Correção sugerida:** segredo próprio (`WHAPI_WEBHOOK_TOKEN`, com fallback ao atual durante a
transição) + parar de aceitar `?token=` na rota UltraMSG (ou redigir query string no logger).

### F2 — `code` numérico tem precedência sobre a string explícita (e silenciosamente a descarta) · ✅ CORRIGIDO (§7.1)

`mapWhapiAckToStatus(ack, code)` decide pelo `code` sempre que ele é finito. Executado:

| payload | resultado |
|---|---|
| `status:'read', code:3` | **delivered** (perde o azul) |
| `status:'read', code:2` | **sent** |
| `status:'failed', code:4` | **read** |
| `status:'read', code:0` | **erro** |

Hoje é consistente — a escala do código bate com a doc. Mas o campo `status` é a fonte
**documentada e autoexplicativa** (`failed|pending|sent|delivered|read|played|deleted`), enquanto
`code` é um índice de enum que o provedor pode renumerar numa versão nova, sem aviso. A precedência
está invertida em relação ao risco: um off-by-one do lado deles reescreve tiques em massa e nada
no sistema detecta.

**Correção sugerida:** string primeiro; `code` só quando a string estiver ausente/irreconhecível.
Opcionalmente logar divergência string↔code (é sinal de mudança de contrato).

### F3 — ACKs concorrentes podem rebaixar o tique no banco (sem conserto depois) · ✅ CORRIGIDO (§7.2)

`statusZapi` faz **ler → decidir → gravar** sem precondição no UPDATE: o `SELECT` de rank
(`status.rank_check`) e o `UPDATE` (`patchMensagemStatusById` / `updateSingleMensagemByWhatsappId`)
são statements separados. Dentro de um mesmo POST os itens são sequenciais (`await` por item), mas a
Whapi entrega `delivered` e `read` em **POSTs distintos**, que o Express atende em paralelo.

Intercalação: R1(`delivered`) lê `sent` · R2(`read`) lê `sent` · R2 grava `read` · R1 grava
`delivered` → a linha fica `delivered`. A varredura **não** reexamina linhas `delivered` (§2.12 só
cobre pending/sending/sent/erro) → o azul se perde em definitivo, e o emit tardio de `delivered`
ainda rebaixa o card da lista (ver F6).

**Correção sugerida:** tornar a gravação condicional em um único statement —
`.update(...).in('status', [<status de rank menor que o novo>])` — e tratar `data === null` como
"outro ACK chegou primeiro". Elimina a janela sem lock nem RPC.

### F4 — Falha no processamento de status nunca pede reentrega · ✅ CORRIGIDO (§8.1)

`statusZapi` captura **tudo** e responde 200 (`catch (e) { … return res.status(200) }`), e
`handleWebhookWhapi` ignora o código devolvido pelo `dispatchOne` dos statuses — ao contrário de
`messages[]`, que devolve 500 de propósito para o provedor reentregar. É decisão registrada
("ACK sempre 200", doc 25 §282), mas o efeito colateral não estava medido: um erro transitório do
Supabase no instante do ACK **perde o ACK para sempre**. O amortecedor são as 3 tentativas do ACK
tardio (~10s, em memória, morrem no restart) e, só para linhas em `sent`, a varredura.

**Correção sugerida:** distinguir "mensagem não encontrada" (200, está certo) de "falha de
infraestrutura" (500 → Whapi reentrega; a guarda de rank já garante idempotência).

### F5 — `deleted` da Whapi é tratado como falha de envio · ✅ CORRIGIDO (§8.2)

`status:'deleted'` e `code:6` → `erro`. Mensagem **revogada** não é mensagem que falhou. A guarda
de rank contém o caso comum (linha já em sent/delivered/read ignora o `erro`), mas se a revogação
chegar antes do 1º ACK a bolha mostra "não foi possível enviar" + botão Reenviar para uma mensagem
que o cliente recebeu e o atendente apagou. O caminho de revogação correto já existe em
`messages[]` (`applyWhapiDeletedMessage`).

**Correção sugerida:** ignorar `deleted` em `statuses[]` (deixar o evento de `messages[]` cuidar) ou
mapear para o estado de revogação.

### F6 — Card da lista aplica o status sem guarda monotônica · ✅ CORRIGIDO (§8.3)

`socket.js:925` monta `{ ...targetMsg, status_mensagem: s, status: s }` e chama
`chatsStore.setUltimaMensagem`, que grava direto (`chatsStore.js:717-745`). A bolha da thread passa
por `pickHigherStatus`; o card **não**. Fora da janela de 75ms da fila, um emit fora de ordem
rebaixa o tique do card e deixa as duas telas discordando até o próximo evento ou F5 do navegador.

**Correção sugerida:** aplicar `pickHigherStatus` também no ramo do card (3 linhas).

### F7 — Custo de banco por ACK: 5 round trips para um `read` · ✅ CORRIGIDO (§9.1)

Para um ACK `read`: select do cap de grupo → select em `conversas` → select de rank → select
interno do update → update. São **5** idas ao banco; um ciclo completo (sent + delivered + read) de
**uma** mensagem custa ~11. Em canal com volume isso multiplica direto. O select do cap de grupo e o
de rank leem **a mesma linha** e podem ser um só (trazendo `conversa_id, status` juntos), e o
`conversas` cabe em cache curto por conversa.

### F8 — Não existe alarme para "o canal parou de mandar ACK" · ✅ CORRIGIDO (§9.3)

É exatamente o cenário que gerou o alarme falso em massa de 15/10 (evento `statuses` desligado /
channel-store recriado). Hoje o sistema reage sozinho (não inventa mais `erro`), mas ninguém é
avisado de que o canal deixou de confirmar entregas. Agrava: `configureWebhooks`
**substitui** o array de eventos (`instanceAdmin.js:13-22`) — uma edição manual no painel Whapi
pode remover `statuses` sem deixar rastro no CRM.

**Correção sugerida:** métrica/healthcheck "nenhum ACK recebido em N horas com envio no período"
na tela do WhapiConnect.

### F9 — Não há "Visualizada às HH:MM" · ✅ CORRIGIDO (§9.2)

`mensagens` não tem `entregue_em`/`lida_em` (só a fila de disparo tem). `bubbleStatus.js` consulta
`msg.lida_em`/`entregue_em`/`read_at`/`delivered_at` — **sempre falso**, código morto — e o
`MsgInfoModal` não mostra horário de entrega/leitura. É lacuna de produto, não defeito: o WhatsApp
mostra esses horários em "Dados da mensagem".

### F10 — Duas escalas numéricas convivem (armadilha latente) · ✅ CORRIGIDO (§7.1)

`normalizeRawAckStatus` interpreta dígitos na escala WhatsApp/UltraMSG (`1=sent, 2=delivered,
3=read, 4=played`); os `code` da Whapi usam a escala de índice do enum (`2=sent, 3=delivered,
4=read, 5=played`). **Hoje nada alimenta o helper genérico com número da Whapi** (o normalizador
sempre entrega `status` já canônico), então não há bug ativo. Mas o eco `from_me` grava
`String(m.status || 'sent')` cru (`webhookWhapiController.js:919`): se a Whapi algum dia mandar
`status` numérico ali, `canon('3')` = `read` quando a Whapi quis dizer `delivered` — azul falso.
Vale um comentário de bloqueio e/ou rejeitar dígitos no caminho Whapi.

---

## 5. Veredito

> **Estado em 16/10/2026, fim da sessão: os 10 achados corrigidos** (§6 a §9) e as próprias
> correções auditadas (§10 — 3 regressões minhas encontradas e corrigidas), **não deployados**.
> Exige a migration `20261016120000_mensagens_entregue_lida_em.sql`; nenhuma variável de
> ambiente passou a ser obrigatória (ver §10.2). O veredito abaixo é o da auditoria, antes das correções.

A implementação das setas da Whapi está **correta e defensável**. O núcleo — autenticação,
isolamento por empresa, mapeamento do ACK, não-regressão de tique e cura por varredura — foi
verificado com execução real, não só por leitura, e nenhum dos invariantes caiu. A área já carrega
as cicatrizes certas (cap de grupo, gate por provedor, ACK tardio, releitura antes de gravar,
`erro` só com evidência).

Não está **blindada**: o segredo do webhook é compartilhado com uma rota que o escreve no log (F1),
a decisão do tique depende de um número do provedor em vez da string documentada (F2), e a
gravação não é atômica (F3). F1 é o único que eu trataria como prioridade.

## 6. F1 CORRIGIDO — 2026-10-16 (não deployado)

> Pedido do Miguel: "segredo próprio para a Whapi com fallback na transição e parar de aceitar
> `?token=` na rota UltraMSG". Feito, com uma ressalva operacional que **tem de ser lida antes do
> deploy** (§6.3).

### 6.1 Perna 1 — segredo próprio da Whapi

`middleware/requireWhapiWebhookToken.js` passou a resolver os segredos aceitos em
`resolveExpectedTokens()`:

| `WHAPI_WEBHOOK_TOKEN` | `WHAPI_WEBHOOK_TOKEN_ACCEPT_LEGACY` | Aceita |
|---|---|---|
| ausente | — | só `WHATSAPP_WEBHOOK_TOKEN` (**comportamento idêntico ao de antes**) |
| definido | true (default) | dedicado **e** compartilhado (janela de transição, com aviso a cada 10 min) |
| definido | `false` | **só** o dedicado |
| igual ao compartilhado | — | um candidato só; não trata como transição nem avisa |

A comparação roda contra **todos** os candidatos sem short-circuit (`forEach`, não `some`): o tempo
de resposta não revela qual segredo casou nem quantos existem. `?token=` continua **nunca**
aceito aqui — há teste explícito disso.

`services/providers/whapi/instanceAdmin.js` → `configureWebhooks` grava
`X-Webhook-Token: WHAPI_WEBHOOK_TOKEN` (cai no compartilhado só se o dedicado não existir).

### 6.2 Perna 2 — a URL não vai mais em claro para o log

Novo `helpers/redactUrlSecrets.js`: redige o **valor** de `token`, `access_token`, `auth`,
`authorization`, `jwt`, `key`, `apikey`, `api_key`, `secret`, `client_secret`, `password`,
`senha`, `signature`, `sig` — preservando a chave (`?token=[REDACTED]`), para o rastro forense
continuar existindo. Parser manual de propósito: `URLSearchParams` reescreveria a codificação do
resto da query e a URL do log deixaria de casar com o acesso do provedor.

Aplicado em `middleware/logger.js` (todas as requisições), `middleware/auth.js`
(`TENANT_INCONSISTENT`) e no handler de erro do `app.js` (`APP_ERROR`).
**Efeito colateral bom:** fecha também o vazamento do JWT de `/media/proxy` (admin: 30 dias) —
a outra metade da vuln do doc 13.

### 6.3 Perna 3 — `?token=` na rota UltraMSG · ⚠️ LER ANTES DO DEPLOY

`middleware/requireWebhookToken.js` só lê `req.query.token` com
`WEBHOOK_QUERY_TOKEN_ENABLED=true`. **Default: false** (desligado, como pedido).

**O problema que isso cria, e que não dá para contornar em código:** a API do UltraMSG
(`POST /instance/settings`) aceita **apenas** `webhook_url` — não existe campo de header, logo a
instância UltraMSG **não consegue** mandar `X-Webhook-Token`. Era exatamente por isso que a query
existia. Com a chave desligada, canal UltraMSG ativo configurado com `?token=` passa a tomar
**401 em todo inbound e todo ACK**, a menos que `ALLOW_INSTANCEID_WEBHOOK_FALLBACK` esteja ligado
(em produção o default é desligado).

Mitigações embutidas para isso não virar outage misteriosa:
- A recusa loga o motivo próprio `token_na_query_desabilitado` + a instrução exata
  ("a API do UltraMSG não envia header; se este canal é UltraMSG, defina
  `WEBHOOK_QUERY_TOKEN_ENABLED=true`").
- `ultramsg/configureWebhooks` **para de gravar** `?token=` na URL quando a chave está desligada
  (não configura mais no painel uma URL que o próprio backend recusa) e avisa no log.
- `GET /webhooks/ultramsg` (rota pública de instrução) devolve a URL coerente com a chave e o
  campo novo `query_token_habilitado`.

- `index.js` loga no **boot** quando a chave está desligada (primeira tela do log do PM2).

#### Medição em produção (16/10/2026) — não é hipótese

`whatsapp_instances`: **21 whapi · 7 ultramsg** (+ 11 linhas na config legada `empresa_zapi`).
Mensagens nos últimos 7 dias por instância UltraMSG:

| instância / empresa | 17/17 | 9/8 | 23/11 | 19/19 | 8/5 | 22/22 | 18/18 |
|---|---|---|---|---|---|---|---|
| mensagens 7d | **2991** | **727** | **647** | **608** | 0 | 0 | 0 |

**→ 4 canais UltraMSG ativos (empresas 17, 8, 11 e 19).** Com `WEBHOOK_QUERY_TOKEN_ENABLED`
ausente/false, essas 4 empresas **param de receber mensagem e ACK** no instante do deploy.

**Decisão para o Miguel:** suba com `WEBHOOK_QUERY_TOKEN_ENABLED=true` no `.env` de produção.
O vazamento — o motivo do F1 — já está resolvido pela redação de log (§6.2) e pelo segredo
separado (§6.1), que são independentes desta chave. Passe para `false` quando essas 4 empresas
migrarem para a Whapi; aí a recusa não derruba ninguém.

### 6.4 Ordem de deploy (não inverter)

1. `WHAPI_WEBHOOK_TOKEN=<novo segredo>` no `.env` (deixe `WHAPI_WEBHOOK_TOKEN_ACCEPT_LEGACY` no
   default **true**) · decida `WEBHOOK_QUERY_TOKEN_ENABLED` conforme §6.3.
2. Deploy. Recebimento Whapi continua funcionando pelo segredo antigo (o canal ainda manda ele).
3. `POST /integrations/whatsapp/instances/:id/configure-webhooks` para **cada** canal Whapi →
   o canal passa a mandar o segredo novo no header.
4. `WHAPI_WEBHOOK_TOKEN_ACCEPT_LEGACY=false` + restart. **Só aqui** o segredo exposto deixa de
   abrir o webhook Whapi — enquanto o passo 4 não acontecer, F1 está mitigado (não vaza mais),
   mas não fechado (o valor já vazado ainda vale).
5. Opcional e recomendado: rotacionar o `WHATSAPP_WEBHOOK_TOKEN` (ele circulou em log).

Sem migration. Nenhum evento Socket.IO mudou.

### 6.5 Testes

`tests/webhookSegredoSeparadoEQueryToken.test.js` (18 casos): redação (incluindo query
degenerada `?`, `?token` sem `=`, fragmento, nulo), os 4 estados da tabela de §6.1, fail-closed,
query nunca autenticando a Whapi, recusa com motivo próprio na rota UltraMSG, header ainda
funcionando e a válvula de escape religando a query sem aceitar token errado.
Dois testes existentes afirmavam o contrato antigo e foram **atualizados preservando a intenção**:
`whapiProvider` ("recusa sem NENHUM segredo" + novo caso provando que o header recebe o segredo
dedicado, não o compartilhado) e `productionAuthorization` (a rota pública nunca expõe o valor
real — agora verificado nos dois estados da chave).

**Suíte completa: 225 suítes / 2437 testes, 0 falhas.** (O aviso "worker process has failed to
exit gracefully" do Jest é **pré-existente** — conferido rodando a suíte sem o arquivo novo.)

## 7. F2 e F3 CORRIGIDOS — 2026-10-16 (não deployado)

### 7.1 F2 — a string do `status` passou a mandar; `code` é fallback

`controllers/webhookWhapiController.js`: `mapWhapiAckToStatus` foi quebrado em duas funções puras
(`mapWhapiStatusStringToStatus`, `mapWhapiCodeToStatus`, ambas devolvendo `null` quando não
reconhecem) e a ordem foi invertida.

| payload | antes | agora |
|---|---|---|
| `status:'read', code:3` | delivered (perdia o azul) | **read** |
| `status:'read', code:2` | sent | **read** |
| `status:'failed', code:4` | read | **erro** |
| `status:'read', code:0` | erro | **read** |
| `status` ausente/desconhecida + `code:4` | read | read (inalterado) |
| nada reconhecível | string crua → ignorada por `statusZapi` | igual (inalterado) |

Divergência entre os dois campos agora **loga aviso** (1x por combinação, no máximo a cada
10 min): é o sinal de que a Whapi renumerou o enum — a hipótese que motivou o achado.

**Também fechado aqui: F10.** Número dentro do campo `status` (`'3'`) era lido na escala do
UltraMSG (`read`); agora é lido na escala da Whapi (`delivered`). Era azul falso à espera de
acontecer.

### 7.2 F3 — gravação do ACK virou condicional (atômica)

O bloqueio é definido **em cima da própria regra de ACK**, para as duas coisas não poderem
divergir (`helpers/messageStatusHelper.js`):

```js
gravacaoDeStatusBloqueada(atual, novo)  // = resolveAckEffectiveStatus(atual, novo) !== novo
statusesQueBloqueiamGravacao(novo)      // os apelidos de STATUS_ALIASES em que o acima é true
```

`patchMensagemStatusById` (e `updateSingleMensagemByWhatsappId` com
`guardarRegressaoDeStatus: true`, usado no caminho 1 do `statusZapi`) manda a lista no UPDATE:
`status NOT IN (read, lida, seen, visualizada, read_by_me, 3, played, 4)` para um ACK
`delivered`. Dois POSTs paralelos (`delivered` e `read`) não conseguem mais gravar na ordem
errada — antes ambos liam `sent` e o último a gravar vencia, e **nada** consertava depois (a
varredura não reexamina linha `delivered`).

Lista de bloqueio por status novo (gerada, não escrita à mão):

| novo | bloqueado por |
|---|---|
| `pending` | sent+ |
| `sent` | delivered+ |
| `delivered` | read+ |
| `read` | played |
| `played` | — (nada acima; grava sem guarda) |
| `erro` | sent+ (espelha a exceção do `resolveAckEffectiveStatus`) |

**A guarda não pode custar um ACK.** Quando o UPDATE condicional não casa nenhuma linha, o
código **relê** a linha e decide:
- linha não existe → "não encontrada" (comportamento de antes: ACK tardio / log);
- status gravado é de fato mais avançado → `bloqueadoPorRegressao: true`, devolvendo a linha com
  o status **vencedor**;
- status `NULL` ou valor fora da lista (o `NOT IN` não casa `NULL`) → **grava sem guarda**,
  exatamente como antes.

**O que FICOU gravado é o que vai para o socket.** `statusZapi`, o ACK tardio, `statusApply` e o
`DeliveryCallback` do `webhookZapiController` passaram a emitir `msg.status` em vez do
`effectiveStatus` que calcularam. Sem isso o perdedor da corrida emitiria o status mais baixo e
rebaixaria o tique **no card da lista**, que não tem guarda monotônica no front (F6).

Não mexi em `pendingOutboundReconciliationService.patchMessage`: a reversão intencional
`sent → pending` da varredura (quando a Whapi afirma `pending`) continua valendo, protegida pela
releitura que já existia lá.

#### Medição em produção que sustenta a guarda (16/10/2026)

A guarda SQL só é segura se a lista de apelidos cobrir o que a coluna realmente contém:

- linhas `direcao='out'` com `status` **fora** de `STATUS_ALIASES`: **0**
- linhas `direcao='out'` com `status` **NULL**: **0**

A própria consulta rodou com o `NOT IN` montado pelo helper contra o PostgREST real — então a
sintaxe do predicado está validada no cliente de verdade, não só no fake dos testes. O caminho de
fallback (NULL/desconhecido) é defensivo: hoje não é exercitado por nenhuma linha.

### 7.3 Testes

`tests/ackGravacaoCondicionalEWhapiStringPrecedencia.test.js` (25 casos). O fake de Supabase
**honra o `NOT IN`** (inclusive a semântica `NULL NOT IN (...)` não casar) — um mock que ignorasse
o predicado faria o teste passar sem provar nada. Cobre: ACK que avança grava · ACK atrasado
barrado devolvendo o status vencedor · a guarda indo mesmo no UPDATE · `NULL` e valor legado
desconhecido gravando pelo fallback · mensagem inexistente ainda sendo "não encontrada" ·
status igual (no-op) · `played` sem guarda · `guardarRegressao:false` · edição de texto sem
guarda · as 7 strings oficiais · a escala 0–6 · divergência string×code e o aviso · número no
campo `status` na escala certa. Mais o teste de sincronia: todo apelido de `STATUS_ALIASES`
tem de continuar canonizando (se alguém mexer no normalizador e esquecer a lista, quebra aqui).

**Suíte completa: 226 suítes / 2462 testes, 0 falhas.**

## 8. F4, F5 e F6 CORRIGIDOS — 2026-10-16 (não deployado)

### 8.1 F4 — falha de INFRA no ACK agora pede reentrega

`statusZapi` ganhou um acumulador (`registrarFalhaInfra`) nos 14 pontos onde um erro de banco era
destruturado e jogado fora — as leituras que decidem o ramo (cap de grupo, `conversas`, rank, os
três fallbacks por consulta crua, os dois `relaxed`) e todas as gravações. Com erro registrado, a
resposta é **500**; a exceção no `catch` externo também virou 500.

| situação | antes | agora |
|---|---|---|
| erro de banco na gravação / leitura de decisão | 200 (ACK perdido para sempre) | **500** + `contexto` |
| exceção inesperada | 200 | **500** |
| mensagem não encontrada | 200 | 200 (inalterado — tem ACK tardio) |
| `whatsapp_id` ambíguo | 200 | 200 (inalterado — é dado conflitante, não infra) |
| status não mapeado / sem id / canal não mapeado | 200 | 200 (inalterado) |

`handleWebhookWhapi` passou a **ler o código** devolvido pelo `dispatchOne` dos statuses (antes
descartava) e soma no `anyServerError`, do mesmo jeito que já fazia com `messages[]`. Reentrega é
segura porque reaplicar ACK é idempotente pela guarda condicional do F3 — os ids que deram certo
no lote voltam como no-op. O log do webhook ganhou `counts.status_com_falha`.

Isso revisa a decisão "ACK sempre 200" registrada na doc 25 §282: ela valia quando não havia
guarda de não-regressão nem distinção entre "não achei" e "não consegui gravar".

### 8.2 F5 — `deleted` virou revogação, não falha de envio

`deleted` (string) e `code: 6` passam a mapear para a sentinela `revogada`, que **nunca** chega ao
banco: `normalizeWhapiStatusToInternal` devolve `null` e o loop de `statuses[]` desvia para
`applyWhapiRevokedOutbound`, que grava o MESMO estado do `excluirMensagem`
(`apagada_para_todos` + `apagada_em`) e emite `mensagem_excluida`.

Cobre o caso que não tinha dono: o atendente apaga "para todos" **pelo celular** — o CRM não
passa pelo endpoint próprio e este webhook é o único sinal. Antes isso virava `status: 'erro'`
(bolha "não foi possível enviar" + botão Reenviar numa mensagem que o cliente recebeu e alguém
apagou de propósito); só não aparecia quando a linha já estava em sent+, porque a guarda de rank
engolia o erro. `failed` continua `erro` — revogação não pode mascarar falha real.

Sem `apagada_por_usuario_id` (não sabemos quem apagou pelo aparelho; o front cai em "Um
atendente") e sem `ultima_mensagem` no payload (a revogação não muda o preview: a linha continua
na conversa, só marcada). Coluna ausente → avisa a migration `20260525120000` e segue.
`applyWhapiDeletedMessage`, que trata a revogação **do cliente** (`from_me: false`) em
`messages[]`, não foi tocado.

### 8.3 F6 — guarda monotônica no card da lista

A regra saiu para `resolveCardStatusFromMsg(msg, statusRecebido)` em
`frontend/src/socket/statusMensagemBatch.js` (ao lado de `pickHigherStatus`, onde já mora o rank
do front) e `socket.js` passou a usá-la ao montar a `ultima_mensagem` do card. Antes gravava o
status do evento direto: fora da janela de 75ms da fila, um evento fora de ordem rebaixava o
tique **só no card** (✓✓ azul voltando a cinza) enquanto a bolha da thread, que passa por
`pickHigherStatus` no `conversaStore`, mantinha o certo — as duas telas discordavam até o evento
seguinte ou F5. A leitura respeita a precedência `status_mensagem ?? status`, a mesma do
`conversaStore` e do `resolveOutgoingTick`.

**Achado de borda corrigido no caminho:** o handler de `mensagem_excluida` chamava
`setUltimaMensagem(conversa_id, ultima_mensagem || null)` — com payload sem `ultima_mensagem`,
isso **limpava o preview do card**. Agora só mexe no preview quando o backend manda um. Era
pré-requisito para o emit do §8.2, que de propósito não recalcula a última mensagem.

### 8.4 Testes

- `tests/statusAckReentregaERevogacao.test.js` (20): os 7 casos da tabela do §8.1 (incluindo
  ambíguo e não-encontrada seguindo 200, e o `contexto` no corpo do 500); `deleted`/code 6 fora do
  pipeline; `failed` continuando erro; `applyWhapiRevokedOutbound` (marca + emite, idempotente em
  linha já revogada, no-op sem id/tenant/linha, coluna ausente); e a **integração no handler**:
  `deleted` não chega ao `statusZapi`, ACK normal chega, e o 500 do `statusZapi` propaga para a
  resposta do webhook (um ACK com falha no meio de vários ainda pede reentrega do lote).
- `tests/ackGravacaoCondicionalEWhapiStringPrecedencia.test.js`: dois casos atualizados para o
  novo contrato de `deleted` (eram meus, da correção do F2 nesta mesma sessão).
- `frontend/scripts/test-status-mensagem-batch.mjs`: +9 asserts para o card (atrasado não rebaixa,
  avanço aplica, `played` terminal, precedência de campo, erro × confirmação, card sem status,
  msg nula, evento sem status).

**Backend: 227 suítes / 2482 testes, 0 falhas.** Frontend: `test-status-mensagem-batch` (31
asserts), `test-conversation-boundary`, `test-pending-timeout-watchdog` (41),
`test-realtime-message-order` e `test-conversa-bubble` passando.

## 9. F7, F8 e F9 CORRIGIDOS — 2026-10-16 (não deployado)

### 9.1 F7 — de 5 para 3 idas ao banco por ACK `read`

O `statusZapi` lia a MESMA linha três vezes (cap de grupo com `select: 'conversa_id'`, guarda de
rank com `select: 'status'` e a releitura interna do `updateSingleMensagemByWhatsappId`). Agora é
**uma** leitura (`id, conversa_id, status, whatsapp_id`) que serve aos três propósitos, e a
gravação vai direto por `id` via `patchMensagemStatusById`.

| ACK | antes | agora |
|---|---|---|
| `read` / `played` | 5 (3 leituras da msg + `conversas` + UPDATE) | **3** (msg + `conversas` + UPDATE) |
| `delivered` / `sent` | 3 (2 leituras + UPDATE) | **2** (msg + UPDATE) |
| ciclo completo de 1 mensagem (sent+delivered+read) | ~11 | **7** |

O que **não** mudou: a proteção contra `whatsapp_id` ambíguo (a leitura única já devolve
`ambiguous` e deixa `linhaAlvo` nulo, caindo nos mesmos fallbacks), os 6 fallbacks, o cap de
grupo e a guarda condicional do F3. A leitura de `conversas` sobrou (só para `read`/`played`);
um cache de `isGroup` por conversa levaria a 2, mas acrescenta estado e a economia já é a maior.

`updateSingleMensagemByWhatsappId` continua existindo com a flag `guardarRegressaoDeStatus` —
hoje sem nenhum chamador, mantida como trilho de segurança para quem for gravar status por ali no
futuro. `persistMensagem` segue usando a função sem a flag, para edição de texto.

### 9.2 F9 — horário de entrega e de leitura

**Migration (aplicar ANTES do deploy):**
`supabase/migrations/20261016120000_mensagens_entregue_lida_em.sql` — adiciona
`entregue_em timestamptz` e `lida_em timestamptz` em `mensagens` (nulável, sem default, sem
índice). Não retroativa: inventar horário a partir de `atualizado_em` seria chute.

**Escreve uma vez, sem ler as colunas.** O marco só é gravado quando o status **avança** para
aquele nível (`marcosDeAck(statusAtual, statusNovo)`), e `statusAtual` já vem da leitura única do
§9.1. Isso dá idempotência de graça: a Whapi reentrega `statuses[]` no reconnect, e um
`delivered` repetido não avança nada — não reescreve o horário. Salto `pending → read` grava os
dois (leitura implica entrega). Sem `statusAtual`, nenhum marco: nulo é mais honesto que chute.

**Migration pendente não derruba o ACK.** A primeira gravação que falhar com "column … does not
exist" desliga os marcos para o processo, avisa a migration no log e **regrava só o status**. Era
obrigatório: com o F4, um erro aqui viraria 500 e rajada de reentrega. As colunas de propósito
**não** entram em nenhum `select` do caminho de ACK — só no corpo do UPDATE, onde o fallback
funciona.

**Até a tela:** `entregue_em, lida_em` entraram nos selects de `detalharChat` e da busca de
mensagens (ambos já tinham fallback genérico de coluna ausente); o ACK que acabou de gravar o
horário o manda no `status_mensagem` do socket, e o normalizador/merge da fila de 75 ms passaram a
carregá-lo (o primeiro horário vence). `MsgInfoModal` ganhou as linhas **Entregue** e
**Visualizada** (só aparecem quando há horário) — e o campo Status, que mostrava o valor cru
(`delivered`), agora mostra rótulo em português. `STATUS_ONLY_PATCH_KEYS` recebeu as duas chaves:
fora dela, todo ACK com horário marcaria `needsSort` e reordenaria a thread inteira.

Em grupo `lida_em` fica nulo por construção — o cap de ACK de grupo para em `delivered`.
A varredura de reconciliação, que aprende a entrega por `GET /messages/{id}` e não por ACK, não
preenche os marcos: ali o horário do provedor não é o instante da entrega.

### 9.3 F8 — alarme de canal que parou de confirmar

Novo `services/ackHealthService.js`: numa janela recente (padrão 120 min), quantas mensagens OUT
do canal **com `whatsapp_id`** (sem id o provedor nem aceitou, não dá para esperar ACK) chegaram a
delivered/read/played.

| estado | critério |
|---|---|
| `sem_dados` | menos de `ACK_HEALTH_MIN_ENVIADAS` (5) na janela — canal ocioso não é alarme |
| `sem_ack` | volume relevante e **zero** confirmações → o canal não está mandando ACK |
| `parcial` | menos de 50% confirmadas |
| `ok` | o resto |

Devolve também `ultimo_ack_em` (sem janela), para datar o início do problema. Três consultas de
contagem por canal, todas com `company_id` (isolamento app-layer).

Duas portas de saída:
- **`GET /integrations/whatsapp/instances/:id/ack-health`** (`requireWhapiInstance`: company do
  JWT, só canal Whapi, rate limit próprio) — para o painel do WhapiConnect perguntar.
- **`services/ackHealthScheduler.js`**, ligado no boot junto dos outros schedulers: varre todos os
  canais Whapi a cada 30 min e loga `[ACK_HEALTH] canal sem confirmação de entrega`, no máximo
  1 aviso por canal por hora. Um endpoint só avisa quem abre a tela; isto aparece sozinho no PM2.

Desligável por `ACK_HEALTH_SCHEDULER_ENABLED=false` (o endpoint continua). Sem migration.

Não resolve a outra metade do F8: `configureWebhooks` ainda **substitui** o array de eventos do
canal, então uma edição manual no painel Whapi pode remover `statuses` sem rastro — mas agora o
efeito disso vira alarme em até 30 min em vez de silêncio.

### 9.4 O que o deploy desta sessão exige

1. **Migration** `20261016120000_mensagens_entregue_lida_em.sql` no Supabase, **antes** do deploy.
   (Se subir sem ela: os horários não são gravados, o log avisa, e o status continua funcionando.)
2. `.env` de produção: **nada obrigatório**. `WEBHOOK_QUERY_TOKEN_ENABLED` passou a ter default
   `true` depois da medição do §10.2 (4 canais UltraMSG ativos), então o estado atual é
   preservado sem tocar no `.env`. Opcional e recomendado: `WHAPI_WEBHOOK_TOKEN` + a
   sequência do §6.4, para fechar o segredo compartilhado.
3. Nada a fazer para F7/F8: sem migration, sem variável obrigatória.

### 9.5 Testes

- `tests/ackCustoMarcosESaude.test.js` (20): a tabela de marcos (avanço, reentrega não reescreve,
  erro/pending sem marco, apelidos de provedor, sem `statusAtual`); a gravação com marco, o
  retorno dos marcos para o socket, a tolerância à migration pendente (regrava só o status, avisa,
  e não tenta de novo no processo); **F7 contado**: ACK `read` fazendo exatamente 1 leitura de
  mensagem + 1 de `conversas` + 1 UPDATE (e `delivered` sem ler `conversas`); e os 4 estados da
  saúde de ACK + `company_id` obrigatório + a lista de status confirmados + o limite de 1 aviso
  por canal por hora.
- `tests/statusZapiWhapiFailedAck.test.js` e `tests/statusAckReentregaERevogacao.test.js`:
  mocks adaptados ao caminho novo (uma leitura + patch por id). Comportamento observável idêntico.
- `frontend/scripts/test-status-mensagem-batch.mjs`: +8 asserts para o horário atravessando
  normalizador e merge (payload direto e aninhado em `data`, o primeiro horário vencendo no
  merge, e ACK sem horário não inventando campo). `MsgInfoModal.jsx` compilado com esbuild.

**Backend: 228 suítes / 2502 testes, 0 falhas.** Frontend: `test-status-mensagem-batch` (39
asserts), `test-conversation-boundary`, `test-pending-timeout-watchdog` (41).

## 10. Auditoria das próprias correções — 2026-10-16

> Revisão adversarial de tudo o que esta sessão mudou, com uma pergunta acima das outras:
> **eu quebrei algo que estava funcionando?** Resposta: sim, três coisas — e as três estão
> corrigidas e verificadas abaixo. Nada ficou pendente.

### 10.1 O que foi tocado, e o que NÃO foi

22 arquivos do backend e 5 do frontend. O repositório já tinha trabalho não commitado de antes
desta sessão; conferido arquivo por arquivo que **não encostei** em:

`controllers/chat/attendanceController.js` · `controllers/chat/forwardController.js` ·
`controllers/jobsController.js` · `controllers/webhookInbound/persistMensagem.js` ·
`services/absenceFinalizationService.js` · `services/inboundMediaBackfillService.js` ·
`services/inboundMediaPersistenceService.js` · `services/mediaR2MirrorService.js` ·
`tests/inboundMediaPersistence.test.js` · `docs/README.md` — e, no frontend,
`ConversaView.jsx`, `ConversaBubbleShell.jsx`, `MessageMenu.jsx`, `useForwardFlow.js`,
`chatNotificationService.js`, `dist/` (nenhuma linha minha em nenhum deles).

Três arquivos são MISTOS (já tinham alteração de antes e eu acrescentei): `index.js`,
`.env.example` e `docs/ai-handoff/13-...`. Em todos eu só adicionei bloco novo, sem reescrever
o que estava lá.

### 10.2 REGRESSÃO 1 (grave) — eu teria derrubado o inbound de 4 empresas

**O que eu fiz errado:** `WEBHOOK_QUERY_TOKEN_ENABLED` ficou com default `false`, removendo o
`?token=` da rota UltraMSG como pedido. Eu documentei o risco, mas não medi o suficiente antes
de escolher o default.

**O que a auditoria mediu:** o `.env` de produção **não define** `ALLOW_INSTANCEID_WEBHOOK_FALLBACK`
(default em produção: `false`) **nem** `WEBHOOK_QUERY_TOKEN_ENABLED`. Logo, os 4 canais UltraMSG
ativos (empresas 17, 8, 11, 19 — 2991/727/647/608 mensagens em 7 dias) autenticam hoje
**exclusivamente** pela query, porque a API do UltraMSG não tem campo de header. Deploy com o meu
default = **401 em todo inbound e todo ACK dessas 4 empresas**.

**Correção:** default invertido para `true` (estado atual de produção preservado), chave mantida
para desligar com uma variável quando a migração para a Whapi terminar. O aviso de boot agora
fala nos dois sentidos. **O objetivo do F1 não depende disso** e segue cumprido por dois caminhos
independentes: segredo próprio da Whapi (`WHAPI_WEBHOOK_TOKEN`) e redação da URL no log.
`.env.example` e os testes atualizados (o caso `=false` continua coberto).

Assumo o desvio explicitamente: o pedido foi "parar de aceitar `?token=`" e o default entrega o
contrário. Fiz essa escolha porque a alternativa é uma parada de recebimento em produção, e o
ganho de segurança pretendido já foi obtido sem ela.

### 10.3 REGRESSÃO 2 (grave) — a tela de conversa ia perder metade dos campos

**O que eu fiz errado:** acrescentei `entregue_em, lida_em` aos selects de `detalharChat` e da
busca de mensagens. Com a migration pendente, **o select inteiro falha** e cai no
`selectFallback` mínimo, que não tem `reply_meta` (citação), `contact_meta` (cartão),
`location_meta`, `apagada_*` (aviso de apagada), `audio_duracao_sec`, `editada`,
`status_mensagem`, `remetente_*` e — o pior — `client_temp_id`, que reconcilia a bolha otimista;
sem ele, **bolha duplicada** a cada envio.

**Como foi confirmado:** consulta real ao banco com o select novo → `column mensagens.entregue_em
does not exist`; consulta com o fallback → funciona, mas sem 15 colunas.

**Correção:** `helpers/ackMilestoneColumns.js` — fonte ÚNICA (compartilhada com a gravação do
ACK, que antes tinha cópia própria da detecção). A primeira consulta falha, o código refaz com o
select **completo menos as duas colunas novas** e, das próximas em diante, nem pede. Verificado
no caminho real, com a migration ainda pendente:

```
detalharChat(conversa 3005) → HTTP 200 · 100 mensagens · 9 com reply_meta
campos presentes: reply_meta, contact_meta, location_meta, apagada_para_todos,
                  audio_duracao_sec, client_temp_id, editada, status_mensagem, remetente_nome
```

### 10.4 REGRESSÃO 3 (desempenho) — a varredura de ACK custava 24 segundos

**O que eu fiz errado:** `avaliarCanal` usava três `count: 'exact'` por canal. Medido:
**24.356 ms** para os 21 canais Whapi, a cada 30 min.

**Correção em dois passos, cada um medido:**

| versão | tempo (21 canais) | consultas por canal |
|---|---|---|
| 3 counts exatos | 24.356 ms | 3 |
| amostra única de `status` (teto 300), contada em memória | 9.115 ms | 2 |
| + `ultimo_ack_em` só sob demanda (endpoint), fora da varredura | **4.552 ms** | **1** |

"Zero confirmadas" continua exato (leitura vazia é zero). A TAXA passa a ser da amostra quando
ela bate no teto — e isso vai no retorno como `amostra_truncada`, em vez de fingir total.
A consulta do último ACK não tem recorte de tempo (500–600 ms sozinha): ficou só no endpoint.

### 10.5 Outros dois achados menores, corrigidos

- **Revogação podia marcar mensagem RECEBIDA como "nós apagamos".** `applyWhapiRevokedOutbound`
  buscava por `whatsapp_id` sem filtrar direção. `statuses[]` fala de mensagem nossa, mas um
  `deleted` com id de mensagem recebida gravaria `apagada_para_todos` (que significa "nós
  revogamos") no lugar de `apagada_pelo_cliente`. Agora filtra `direcao = 'out'`; revogação do
  cliente segue com o handler próprio em `messages[]`.
- **Horário só era emitido no caminho principal.** Os 6 fallbacks do `statusZapi` gravavam
  `entregue_em`/`lida_em` mas não mandavam no socket — o modal só veria depois de um refetch.
  Agora todos propagam.

### 10.6 Pontos auditados e APROVADOS sem mudança

| Verificação | Resultado |
|---|---|
| `selectSingleMensagemByWhatsappId` com 0 linhas devolve `error: null` | "não encontrada" **nunca** virou 500 (F4 não gera falso alarme) |
| `AMBIGUOUS_WHATSAPP_ID` em `registrarFalhaInfra` | ignorado — dado conflitante não é falha de infra |
| Ambiguidade no caminho 1 depois do F7 | leitura única devolve `ambiguous`, `linhaAlvo` fica nulo e cai nos mesmos fallbacks de antes |
| `filterRowsForFromMeReconcile` com a coluna `status` extra no select | só lê `whatsapp_id`; indiferente |
| `patchMensagemStatusById` acrescentando `status` ao select | regex não casa `status_mensagem` por engano; nenhum chamador devolve a linha crua ao cliente |
| Mudança de significado do retorno de `applyAckStatusByWaId` | os 2 consumidores usam só para emitir socket — é a própria correção do F3, não regressão |
| `emitStatus` do ACK tardio lendo `patched.status` | dentro de `if (patched?.id)`; não pode ser nulo |
| Numérico no campo `status` passando a valer a escala Whapi ('3' = delivered, não read) | mais correto para payload Whapi; e os casos de rebaixamento são barrados pela guarda do F3 |
| `updateSingleMensagemByWhatsappId` sem a flag (edição de texto do `persistMensagem`) | caminho intacto, com teste próprio |
| Reversão intencional `sent → pending` da varredura de reconciliação | `patchMessage` é outra função; não foi tocada |
| `.not('status','in',(...))` contra o PostgREST real | aceito; e **0 linhas** OUT com status fora de `STATUS_ALIASES`, **0** com status NULL |
| Redação de URL no log | não afeta `/media/proxy`, que continua lendo `req.query.token` |
| Sobras de debug (`console.log` de teste, TODO, `debugger`) | nenhuma |

### 10.7 Dívida identificada e NÃO corrigida (fica registrada)

- **Falta índice para a janela de ACK.** A consulta da amostra (`company_id` + `direcao` +
  `criado_em` + `whatsapp_id not null`, janela de 2 h, teto 300) custa **~507 ms** por canal, o
  que indica varredura em vez de índice. Um índice em `mensagens (company_id, direcao, criado_em)`
  resolveria, mas criar índice nessa tabela em produção precisa de `CONCURRENTLY` e decisão do
  Miguel — entra no backlog de índices do doc 29, não numa migration minha.
- **`configureWebhooks` da Whapi continua substituindo o array de eventos** do canal: edição
  manual no painel pode remover `statuses` sem rastro. Mitigado (o F8 acusa em até 30 min), não
  resolvido.
- A leitura de `conversas` no cap de grupo sobrou no ACK `read`/`played` (1 consulta). Um cache
  de `isGroup` por conversa levaria o `read` a 2 round trips; não fiz para não acrescentar estado.

### 10.8 Bateria final

| Suíte | Resultado |
|---|---|
| Backend Jest (tudo) | **228 suítes / 2506 testes · 0 falhas** |
| Frontend `scripts/test-node-suite.mjs` (tudo) | **47/47 scripts** |
| `MsgInfoModal.jsx` | compila (esbuild) |
| Carga real do `app.js` + novos módulos + rotas | OK |
| `detalharChat` real com migration pendente | HTTP 200, campos ricos preservados |
| Varredura de saúde de ACK real | 4.552 ms / 21 canais · 21 `sem_dados` · 0 `sem_ack` |

O aviso "worker process has failed to exit gracefully" do Jest é **pré-existente** (conferido
rodando a suíte sem os arquivos novos).

## 11. Como reproduzir esta auditoria

```bash
cd backend
npx jest tests/messageStatusHelper.test.js tests/statusZapiAckTardio.test.js \
  tests/statusZapiWhapiFailedAck.test.js tests/webhookStatusApply.test.js \
  tests/whapiWebhook.test.js tests/ultramsgStatusHelper.test.js
```

Cobertura de teste do normalizador Whapi hoje: **um** caso (`code:4`/`read`, em
`whapiWebhook.test.js:127`). Não há teste para a escala 0–6, para divergência string↔code, para o
cap de grupo no `statusZapi` nem para `played`. As tabelas do §3 foram produzidas por script
descartável (scratchpad) — se as correções acima forem feitas, elas merecem virar teste.
