# 34 — Sincronização da exclusão de conversa (ZapERP ↔ WhatsApp)

> Implementado em 2026-10-19. **Não deployado.** Sem migration.
> Código: `services/chat/deletion/conversationDeletionService.js`,
> `services/chat/sync/chatDeletionSyncService.js`,
> `controllers/chat/conversationCleanupController.js`, `controllers/webhookWhapiController.js`,
> `services/providers/whapi/instanceAdmin.js`, `controllers/whatsappIntegrationController.js`.

---

## 1. O que cada provedor REALMENTE permite

Verificado na documentação oficial em 19/10/2026 (o MCP `whapi-mcp` estava fora do ar nesta
sessão; a checagem foi feita na doc pública). **Nada aqui é endpoint inventado.**

| Capacidade | Whapi | UltraMSG |
|---|---|---|
| Apagar a conversa via API | ✅ `DELETE /chats/{ChatID}` | ✅ `POST /{instance}/chats/delete` `{token, chatId}` |
| Limpar mensagens via API | ❌ (sem equivalente estável) | ✅ `POST /{instance}/chats/clearMessages` |
| **Avisar que o chat foi apagado no celular** | ✅ evento `chats`, método `delete` | ❌ **não existe** |

Payload oficial do aviso da Whapi (evento `chats` / `delete`):

```json
{
  "chats_removed": ["919984351847@s.whatsapp.net"],
  "event": { "type": "chats", "event": "delete" },
  "channel_id": "NEBULA-AER3B"
}
```

O mesmo evento `chats` tem outros métodos que **não** são exclusão e não podem ser confundidos
com ela: `post` (chat novo, array `chats[]`) e `patch` (pin/mute/label, array `chats_updates[]`).

### 1.1 Limitação do UltraMSG (sem contorno possível pelo webhook)

As notificações da instância UltraMSG cobrem **mensagem recebida**, **mensagem criada** e **ACK**
(+ download de mídia). Não há evento de chat apagado. Logo, "apaguei a conversa no celular" é
**invisível** para o webhook UltraMSG — nenhuma implementação consegue reagir em tempo real.

Melhor solução possível, implementada: **varredura sob demanda** comparando `GET /{instance}/chats`
com as conversas do ZapERP (§5). Não é tempo real e depende de alguém (ou de um cron do Miguel)
disparar.

### 1.2 Limitação que vale para os dois

Apagar a conversa remove o chat **só da conta de atendimento**. O WhatsApp não expõe API para
apagar a conversa no aparelho do cliente — isso já estava documentado e continua valendo.

---

## 2. ZapERP → WhatsApp (já existia; agora com guarda)

`DELETE /chats/:id` → `apagarChatNoWhatsapp` → `provider.deleteChat` (best-effort; falha lá nunca
impede a exclusão aqui). Novidade: **antes** de chamar o provedor registramos a identidade do chat
na guarda anti-eco (`registrarExclusaoLocal`). Registro antes da chamada de propósito — o provedor
pode aplicar a exclusão e devolver timeout; o eco chegaria sem sabermos que a exclusão foi nossa.

---

## 3. WhatsApp → ZapERP (novo)

```
celular apaga a conversa
  → Whapi POST /webhooks/whapi  { chats_removed: [...], event: chats/delete }
  → resolveWhapiWebhookCompany  (channel_id → company_id + whatsapp_instance_id)
  → extractChatsRemoved         (recusa chats.post / chats.patch / messages.delete)
  → applyWhapiRemovedChats      → aplicarExclusaoRemotaEmLote
  → apagarDependenciasEConversa (MESMA cascata do DELETE /chats/:id)
  → conversa_apagada + atualizar_conversa{removida:true} para todos os atendentes
```

### 3.1 Identificação da conversa

Nunca pelo nome do contato. A chave é **`company_id` + instância + identidade do chat**:

- `...@s.whatsapp.net` / `...@c.us` → só os dígitos (`5534999887766`)
- `...@lid` → `lid:<parte crua antes de @lid>` (casa em `conversas.telefone` ou em `conversas.chat_lid`).
  A parte é preservada **sem tirar não-dígitos** porque é exatamente assim que o inbound grava
  (`payload.js` e `webhookZapiController` usam `replace(/@lid$/i,'')`); normalizar faria a chave
  divergir da do banco num LID com sufixo de device.
- `...@g.us` → grupo, **ignorado** (sair de grupo é outro fluxo; o `DELETE /chats/:id` também recusa)
- `@broadcast` / `@newsletter` → ignorados

O casamento considera as variantes de ±9º dígito (`possiblePhonesForWhatsappIdentity`): o canal
pode ecoar o JID de 12 dígitos para uma conversa gravada com 13 (e vice-versa).

**Isolamento:** conversa de outra empresa nunca entra (filtro `company_id` explícito — SERVICE_ROLE
bypassa RLS). Conversa de outra instância da mesma empresa também não.

**Quando a instância não dá para casar** — linha legada com `whatsapp_instance_id IS NULL`, ou canal
que chegou sem instância resolvida — a única licença para apagar é a empresa ter **um único número
ativo**. Com 2+ números não há como saber de qual número é a conversa, e apagar a errada é
irreversível: nesse caso não apaga (fica para a varredura manual).

**Erro de banco não é "não achei":** falha no SELECT devolve `erro_de_banco` e o webhook responde
**500** para o Whapi reentregar o evento. Com 200 a exclusão se perderia para sempre. Reaplicar é
idempotente — na segunda vez a conversa já não existe.

### 3.2 O que a exclusão remota NÃO faz

- **Não** chama `provider.deleteChat` (o chat já não existe lá) → não há como fechar o ciclo.
- **Não** apaga o cadastro do cliente. Contato, tags do contato, `crm_leads`, `campanha_envios`,
  opt-in/opt-out ficam intactos. O `apagar_cliente=1` continua exclusivo do endpoint HTTP.
- **Não** cria tombstone: se o cliente mandar mensagem depois, o inbound recria a conversa
  normalmente (e uma nova exclusão remota volta a valer).

---

## 4. Anti-loop — por que não há ciclo

Três barreiras independentes:

1. **A exclusão remota não fala com o provedor.** A cascata compartilhada
   (`apagarDependenciasEConversa`) só toca o banco. O caminho "webhook → provider.deleteChat"
   não existe.
2. **Guarda de eco** (`chatDeletionSyncService`, memória do processo, TTL 10 min, PM2 fork =
   1 processo): toda exclusão feita aqui registra `company_id` + todas as variantes de identidade.
   O eco do canal cai em `eco_da_propria_exclusao` e não dispara nada. A guarda é **por tenant**.
3. **A conversa já não existe.** Mesmo expirada a guarda, o eco não encontra linha
   (`conversa_nao_encontrada`) — a não ser que a conversa tenha sido recriada por mensagem nova,
   e é justamente por isso que a guarda de 10 min existe.

---

## 5. Varredura de reconciliação (fallback do UltraMSG)

`POST /integrations/whatsapp/instances/:id/chats/reconciliar-exclusoes` — **admin only**,
rate limit 4/min por empresa+instância. Query/body: `aplicar=1`, `horas=<n>`, `limite=<n>`.

**Só para instância UltraMSG.** Instância Whapi recebe **501**: o `GET /chats` da Whapi é paginado
(devolve a 1ª página) e uma lista parcial classificaria conversa viva como apagada — e não precisa,
porque a Whapi avisa pelo webhook em tempo real. A varredura existe para o provedor que não avisa.

Compara `provider.getChats()` com as conversas da instância e aponta as que já não existem no
WhatsApp. **Conservadora de propósito:**

- `aplicar` é opt-in → **por padrão é simulação** (devolve `candidatos`, não apaga);
- lista **vazia** do provedor aborta (502) — não dá para distinguir "não tem chat" de "a chamada
  falhou", e apagar a base por causa de um 500 do provedor é irreversível;
- lista **parcial** também aborta na hora de aplicar: com amostra de ≥10 conversas elegíveis, se os
  candidatos passarem de **metade** delas a leitura é tratada como truncada (sintoma de paginação ou
  de resposta incompleta), não como exclusão em massa real;
- nunca considera grupo, conversa por LID, conversa sem telefone;
- nunca considera conversa `em_atendimento` (alguém está atendendo agora);
- exige inatividade mínima (`horas`, padrão **24**) — chat novo pode ainda não constar na lista;
- varre da conversa mais parada para a mais recente (`ultima_atividade` asc, teto de 5000 linhas);
- `limite` (padrão **50**) limita quantas são APAGADAS; `total_candidatos` conta todas, para a
  proporção acima ser confiável.

---

## 6. Realtime

Os dois gatilhos emitem o **mesmo par** (`emitirConversaApagada`), então o frontend não precisa
saber quem apagou:

| Evento | Room | Papel |
|---|---|---|
| `conversa_apagada` | visibilidade da conversa (fallback `conversa_<id>`) | fecha a thread aberta |
| `atualizar_conversa { removida: true }` | `empresa_<id>` | tira o card da lista de **todos** os atendentes |

O payload ganhou **`origem`**: `usuario` (apagou no ZapERP) · `whatsapp` (apagou no WhatsApp) ·
`reconciliacao` (varredura). O company-wide é o `atualizar_conversa` — a resolução por
visibilidade já não acha a conversa apagada, por isso ela não pode ser o único caminho.

**Frontend** (`src/socket/socket.js`, `handleConversaRemovidaOuMesclada`): já removia da lista e
fechava a thread. Novo: quando `origem` é `whatsapp`/`reconciliacao` **e** a conversa estava aberta,
mostra o toast "Conversa apagada no WhatsApp" — sem isso a tela sumindo parece erro.

---

## 7. Configuração

| Env | Default | Papel |
|---|---|---|
| `WHATSAPP_CHAT_DELETE_SYNC_INBOUND` | `true` | Chave mestra. `false` = ignora exclusões feitas no WhatsApp. |
| `WHATSAPP_CHAT_DELETE_SYNC_MAX_BATCH` | `5` | Teto de conversas por lote de webhook. Acima disso o lote é **recusado inteiro** e logado. |

**Por que o teto:** `chats_removed` grande costuma ser resync/backlog do canal, não dez exclusões
humanas simultâneas. Apagar 300 conversas por causa de um resync é dano irreversível — o mesmo
raciocínio da guarda anti-histórico do inbound (doc 25 §anti-histórico). Lote recusado fica no log
(`[chatDeletionSync] lote de exclusão RECUSADO`) e a varredura manual continua disponível.

### 7.1 O canal precisa assinar o evento

`WHAPI_WEBHOOK_EVENTS` (`services/providers/whapi/instanceAdmin.js`) passou a incluir
`{ type: 'chats', method: 'delete' }`. **Canal já configurado não recebe o evento até rodar**
`POST /integrations/whatsapp/instances/:id/configure-webhooks`. Assinamos **só** o `delete`:
`chats.post` e `chats.patch` não têm consumidor e só gerariam ruído.

`configureWebhooks` tem uma 3ª tentativa: se o canal recusar o PATCH com 400/422 por causa do
evento `chats`, ele reconfigura **sem** esse evento e devolve `chats_delete: false`. Receber
mensagem vale mais do que espelhar exclusão — sem esse degrau, um canal que recusasse o evento
ficaria com o webhook inteiro desconfigurado.

> Isto corrige o que o doc 25 §"Webhook: canal não assina chats/contacts/groups/presences/calls"
> afirmava — presences já havia sido assinado antes, e agora `chats.delete` também.

---

## 8. Como testar

```bash
cd backend && npx jest tests/exclusaoConversaSincronizacaoWhatsapp.test.js tests/whapiWebhookChatsRemoved.test.js tests/whapiWebhookChatsRemovedIntegracao.test.js tests/apagarConversaHttpRegressao.test.js
```

- `tests/exclusaoConversaSincronizacaoWhatsapp.test.js` (28): identidade (LID cru), isolamento por
  empresa/instância, instância indeterminada em empresa multi-número, ±9º dígito, `chat_lid`, grupo
  ignorado, contato preservado, erro de banco → reentrega, anti-eco por tenant, recriação após
  mensagem nova, teto de lote, reconciliação (aborto com lista vazia **e com lista parcial**,
  simulação, `em_atendimento` e atividade recente fora, aplicação + realtime).
- `tests/whapiWebhookChatsRemoved.test.js` (8): extração do payload oficial, recusa de
  `chats.post`/`chats.patch`/`messages.delete`, tenant e instância sempre do canal.
- `tests/whapiWebhookChatsRemovedIntegracao.test.js` (10): **fiação ponta a ponta** — corpo cru do
  provedor → `handleWebhookWhapi` → cascata no banco → socket. Inclui 500 em falha de banco, 200 no
  eco, lote acima do teto, chave mestra desligada, `chats.post`/`chats.patch` inertes, webhook sem
  contexto de canal e a garantia de que o pipeline de mensagens/ACK não é acionado.
- `tests/apagarConversaHttpRegressao.test.js` (11): o `DELETE /chats/:id` não mudou com a extração
  da cascata — mesmos 200/400/403/404, mesmos campos na resposta, provedor ANTES da cascata, contato
  preservado sem `apagar_cliente`, `apagar_cliente=1` apagando, falha do provedor não bloqueando a
  exclusão local e a guarda anti-loop sendo registrada.

Suíte completa em 20/10: **232 suites / 2563 testes passando**. Frontend: **47/47** scripts Node.
(O aviso "Jest did not exit" na suíte completa é **anterior** a esta frente — verificado rodando a
suíte sem estes arquivos.)

### Teste manual (Whapi)

1. `POST /integrations/whatsapp/instances/:id/configure-webhooks` (assina `chats.delete`).
2. Apagar a conversa no celular → o card sai da lista de todos os atendentes em segundos; quem
   estava com ela aberta vê o toast.
3. Apagar no ZapERP (`DELETE /chats/:id`) → o chat sai do WhatsApp e o eco **não** gera segunda
   exclusão (log sem `[chatDeletionSync] conversa apagada no WhatsApp`).
4. Cliente manda mensagem depois → conversa recriada normalmente.

### Teste manual (UltraMSG)

`POST /integrations/whatsapp/instances/:id/chats/reconciliar-exclusoes` (sem `aplicar`) → confira a
lista de `candidatos` e compare `provider_chats` com `conversas_examinadas`; só então repita com
`?aplicar=1`. Instância Whapi responde 501 de propósito (usa o webhook).

---

## 8.1 Por que "não funcionou" na primeira tentativa (20/10)

Duas causas independentes, as duas confirmadas — uma no canal, outra no código.

> **Resolvido em 20/10 no canal de produção:** o evento `{type:'chats',method:'delete'}` foi
> adicionado ao webhook do canal (via `updateChannelSettings`, só o campo `webhooks`; URL, `mode`,
> header e os demais eventos preservados — a resposta trouxe `changes: ["webhooks"]`). Canal NOVO
> ou recriado continua precisando do `configure-webhooks`, que agora já inclui o evento.

**(a) O canal não assinava o evento.** `getChannelSettings` do canal de produção
(`https://zapapi.wmsistemas.inf.br/webhooks/whapi`) listava só:

```
messages(post,put,patch,delete) · statuses(post,put) · presences(post)
```

Sem `chats/delete` o aviso de "conversa apagada no celular" **nunca chega** — não há o que o
código espelhar. `getAllowedEvents` do mesmo canal confirma que `{type:'chats',method:'delete'}`
é um evento válido e disponível; é só assinatura. Resolve-se rodando
`POST /integrations/whatsapp/instances/:id/configure-webhooks` — o painel WhapiConnect já faz isso
sozinho (`tryAutoWebhook`) ao ser aberto, e tem o botão manual (`handleWebhook`).

**(b) ZapERP → WhatsApp morria em silêncio em conversa sem instância.** `apagarChatNoWhatsapp`
(e `limparChatNoWhatsapp`) faziam:

```js
const instanceId = conv.whatsapp_instance_id ? await resolveConversationWhatsappInstance(...) : null
const instanceProvider = await resolveConversationProvider(company_id, instanceId) // null → 'ultramsg'
```

Conversa com `whatsapp_instance_id` NULO (legado) pulava a resolução e caía no default
`'ultramsg'`. Numa empresa só-Whapi o adapter UltraMSG recusa ("sem instância configurada"),
`deleteChat` devolvia `false` e o `false` era **mudo** — resposta e log não distinguiam "não
apagou" de "apagou". Agora o canal é resolvido como em `outboundController`/`forwardController`
(resolve sempre; sem instância, pergunta o provider **da empresa**) e o fracasso tem causa:
`whatsapp_motivo` na resposta (`conversa_sem_telefone` · `conversa_por_lid` ·
`provider_sem_suporte` · `provedor_recusou` · `erro_de_conexao` · `grupo`) e um `console.warn`
com empresa, conversa, provider e instância.

## 8.2 Teste ao vivo (20/10): B passou, A falhou — o 9º dígito

Depois do deploy: **apagar no celular sumiu do ZapERP** (sentido B certificado em produção —
webhook, guarda de eco e cascata funcionando). **Apagar no ZapERP não saía do WhatsApp.**

Causa medida no canal de produção pelo MCP (só leitura):

```
GET /chats/553493120506@s.whatsapp.net   → 200  (o chat real)
GET /chats/5534993120506@s.whatsapp.net  → 404  "specified chat not found"
```

O chat BR vive na Whapi na forma que o WhatsApp usa — quase sempre **12 dígitos, sem o 9º**.
`toWhapiChatId` passa por `preferredBrSendDigits`, que **insere** o 9º. O `DELETE /chats/{id}`
ia para um endereço inexistente, levava 404 e não apagava nada. O mesmo problema já estava
documentado em `historyChatIdCandidates` ("`toWhapiChatId` sozinho reinsere o 9º e a lista
volta vazia") — só não tinha sido aplicado às ações de chat.

**Correção:** `chatIdCandidates(phone, max=3)` em `whapi/phones.js` (forma crua primeiro, que é
a que o canal costuma ter; depois as variantes ±9º) e `deleteChat` tentando em ordem — **404
tenta o próximo, qualquer outro erro para na hora** (não insiste em falha real). Todas as formas
em 404 devolve `naoExistia`, que o controller traduz em `whatsapp_motivo:
chat_nao_existe_no_whatsapp` — diferente de `provedor_recusou`.

`deleteChat` da Whapi passou a devolver objeto (`{ ok, chatId, httpStatus, naoExistia, error }`);
o UltraMSG continua boolean. Os dois consumidores (`conversationCleanupController` e
`comunidadeController`) aceitam as duas formas.

### A mesma cegueira nas outras ações de chat — corrigido (20/10)

`archiveChat`, `unarchiveChat`, `readChat` e `patchChat` (pin/mute/mark_unread/ephemeral, e os
atalhos `pinChat`/`muteChat`) tinham o mesmo defeito: montavam **um** endereço com
`toWhapiChatId`, então em celular BR gravado com o 9º batiam em 404 e falhavam caladas —
fixar/silenciar "não espelhavam" pelo mesmo motivo que apagar não saía.

A política do `deleteChat` virou a função `runOnChatCandidates(label, phone, opts, call)` em
`whapi/chatsAdmin.js`, e **todas** as ações endereçadas por chat passam por ela, inclusive o
próprio `deleteChat`: tenta `chatIdCandidates` em ordem, **404 vai para o próximo endereço,
qualquer outro erro para na primeira tentativa**, e todas em 404 devolve `naoExistia: true`.
Há um único lugar para mudar essa política.

`clearChatMessages` **não** entra: a Whapi não tem endpoint de limpar as mensagens de um chat
(reconferido em 20/10 — existe apagar chat, apagar mensagem e apagar mídia, nada equivalente),
então continua `notImplemented` 501, sem chamada HTTP e sem endereço a tentar. Quando/se a Whapi
publicar o endpoint, use `runOnChatCandidates`.

**Contrato:** as quatro passaram de boolean para o mesmo objeto do `deleteChat`
(`{ ok, chatId, httpStatus, naoExistia, error }`) — sem isso não dá para distinguir "o chat não
existe em forma nenhuma" de "o provedor recusou", que é o ponto da correção. Consumidores
conferidos um a um: `archiveChat`/`unarchiveChat`/`readChat` **não têm consumidor** fora dos
testes (são superfície do adapter); `patchChat` tem um só, `controllers/chat/preferencesController.js`
(espelho de fixar/silenciar), que ignorava o retorno e agora loga `[patchConversaPrefs] WhatsApp
NÃO espelhou pin/mute` com `motivo`/`http_status` — segue best-effort, nunca quebra o salvamento
da preferência. `clearChatMessages` e `deleteChat` já eram lidos como `r === true || r?.ok === true`
em `conversationCleanupController` e `comunidadeController` (que continuam aceitando as duas
formas, porque o UltraMSG ainda devolve boolean).

Testes: `tests/whapiAcoesChatNonoDigito.test.js` (fetch mockado, sem token nem número real)
cobre as seis entradas — ordem das tentativas, 404 em cadeia, erro não-404 parando na primeira,
200 com body de erro, grupo e LID com endereço único, instância ausente sem chamada, e o 501 do
`clearChatMessages`.

## 8.3 O 200 do provedor não prova que a conversa saiu (21/10)

Depois do fix do 9º dígito, o relato mudou: **o histórico some do aparelho, mas o card da
conversa e a última mensagem continuam na lista.** Ou seja, o `DELETE /chats/{id}` chega no chat
certo (por isso o histórico foi limpo) e ainda assim a conversa não sai da lista.

A doc oficial do endpoint descreve só "deleting chats" e os códigos 200/400/401/404 — **não diz**
se o efeito alcança o aparelho, e o changelog da Whapi tem um "fix" genérico de inconsistência
nesse método. Não dá para afirmar a causa pela documentação; dá para parar de mentir no resultado.

**O que passou a acontecer:** `deleteChat` apaga → **confere** com `GET /chats/{id}` no endereço
exato que o DELETE aceitou → se o chat ainda está lá, apaga **de novo** (agora a última mensagem
já está na visão do canal) → confere outra vez. Persistindo, **arquiva** como último recurso: não
é exclusão, mas tira o card da lista principal, é reversível e não toca em nada do lado do cliente.
O resultado passa a carregar `verificado`, `residuo` e `arquivado`, e o controller devolve
`whatsapp_motivo: residuo_no_whatsapp` / `residuo_arquivado_no_whatsapp` em vez de dizer "apagado".

**O que NÃO fazemos, de propósito:** revogar a mensagem residual. A Whapi só tem
`DELETE /messages/{MessageID}`, que apaga **para todos** (não existe flag de "só para mim" — a
referência da API não lista nenhuma). Isso apagaria a mensagem no aparelho do CLIENTE para
limpar a nossa lista. Não é o que "apagar a conversa aqui" autoriza.

| Env | Padrão | Papel |
|---|---|---|
| `WHAPI_CHAT_DELETE_VERIFY` | on | Conferir depois de apagar. `false` volta ao comportamento antigo (1 DELETE, sem GET). |
| `WHAPI_CHAT_DELETE_ARCHIVE_FALLBACK` | on | Arquivar quando o chat resiste às duas tentativas. |
| `WHAPI_CHAT_DELETE_RETRY_DELAY_MS` | 1200 | Espera entre a 1ª e a 2ª tentativa. |

**Custo:** a exclusão passou a fazer 2 chamadas a mais no caminho feliz (1 DELETE + 1 GET) e, no
pior caso, 5 (DELETE, GET, DELETE, GET, POST archive) com ~1,2 s de espera no meio.

**Ainda em aberto:** se o resíduo persistir mesmo com a 2ª tentativa, a causa é do provedor/do
protocolo, não do nosso endereçamento — e o caminho é reproduzir com a Whapi (chat id + horário)
ou aceitar o arquivamento como o melhor alcançável. O teste ao vivo precisa rodar no canal onde o
problema aparece; o MCP desta sessão só alcança o canal da WM.

## 9. Risco residual

- **Exclusão remota é irreversível e leva o histórico do atendimento** (mensagens, `atendimentos`,
  `historico_atendimentos`, avaliações, tags **da conversa**) — exatamente como o `DELETE /chats/:id`
  sempre fez. Quem apaga no celular está apagando o atendimento no ZapERP. Se isso não for
  desejável para a operação, `WHATSAPP_CHAT_DELETE_SYNC_INBOUND=false` desliga só essa direção.
- **Conversa `em_atendimento` é apagada** pelo caminho do webhook (a varredura, não). Mantido assim
  porque o pedido é espelhar a exclusão; a proteção de `em_atendimento` existe só na varredura, onde
  a inferência é menos confiável.
- **Varredura não cobre Whapi** (501 de propósito, §5). Se o canal Whapi ficar sem assinar
  `chats.delete` por um período, as exclusões dessa janela não são recuperáveis — reassine o evento.
  Cobrir isso exigiria paginar o `GET /chats` da Whapi, o que mudaria `getChats` (usado por outras
  telas) e ficou fora desta rodada.
- **Falha da cascata depois do provedor ter apagado:** `DELETE /chats/:id` chama o provedor antes da
  cascata (ordem que já existia). Se a cascata falhar (500), o chat já saiu do WhatsApp e a guarda de
  eco suprime o aviso que, por acidente, repararia o estado. Repetir a exclusão resolve.
- **Guarda de eco é em memória.** Restart do processo no intervalo entre a exclusão local e o eco
  do canal faz o eco chegar "órfão" — mas aí a conversa já não existe, então o efeito é nulo
  (`conversa_nao_encontrada`). Só haveria exclusão indevida se a conversa fosse recriada por
  mensagem nova **e** o eco antigo chegasse depois **e** o processo tivesse reiniciado no meio.
- **A guarda de lista truncada não tem override.** Uma limpeza real e legítima de mais de metade
  dos chats no celular trava a varredura (`aplicar=1`) e exige conferir a simulação. É de propósito:
  o cenário oposto — aplicar por cima de uma leitura incompleta — é irreversível.
- **Multi-instância sem `whatsapp_instance_id`:** conversa legada sem instância em empresa com 2+
  números ativos **não** é apagada pelo webhook (não há como saber de qual número é). Fica para a
  varredura manual.
