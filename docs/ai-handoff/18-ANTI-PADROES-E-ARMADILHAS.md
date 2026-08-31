# Anti-padrões e armadilhas — ZapERP Backend

> Criado: 2026-08-24. Baseado em falhas reais observadas em sessões anteriores e riscos documentados.  
> Leia antes de qualquer alteração. Cada item descreve um erro que parece razoável mas quebra o sistema.

---

## 1. Nomes que enganam (legado vs. ativo)

| Nome que você vê | O que parece | O que é de verdade |
|---|---|---|
| `webhookZapiController.js` | Handler do provider Z-API (antigo) | **Handler ATIVO** de inbound/ACK do UltraMSG. Nunca remover por nome. |
| Tabela `empresa_zapi` | Credenciais de Z-API (antigo) | **Credenciais UltraMSG ativas** por empresa. Nome é legado. |
| `supabase/schema.sql` | Source of truth do banco | **Fotografia desatualizada**. Fonte real = migrations ordenadas por timestamp. |
| `controllers/webhookController.js` | Handler de webhook | **Shim 410**. Não está montado em `app.js`. Retorna `410 Gone` se chamado. Não editar. |
| `controllers/campanhaController.js` | Módulo de campanhas ativo | **Deletado**. Substituído pelo módulo Disparo. Não procure. |

---

## 2. Erros de multitenancy (o mais crítico)

**Armadilha:** derivar `company_id` de qualquer fonte que não seja o JWT.

```js
// ❌ ERRADO — nunca fazer
const company_id = req.body.company_id;
const company_id = req.query.company_id;
const company_id = req.params.company_id;

// ✅ CORRETO — sempre
const company_id = req.user.company_id; // extraído do JWT pelo middleware/auth.js
```

**Por quê:** `SUPABASE_SERVICE_ROLE_KEY` bypassa **todo** RLS do banco. Se a query não filtrar `company_id` explicitamente, ela pode vazar/alterar dados de qualquer empresa. Não existe proteção de banco compensando um filtro ausente no código.

**Teste obrigatório:** ao adicionar qualquer query nova, criar teste negativo com empresa A tentando acessar ID de empresa B.

---

## 3. Status de mensagem não pode regredir

```js
// ❌ ERRADO — sobrescrever status sem checar
await supabase.from('mensagens').update({ status: 'sent' }).eq('id', id);

// ✅ CORRETO — só avança na progressão
// pending → sent → delivered → read
// ACK fora de ordem deve ser ignorado se o status atual já está à frente
```

**Consequência:** um ACK atrasado ou webhook repetido pode fazer uma mensagem "lida" voltar para "enviada", gerando inconsistência no UI e nos contadores de SLA.

---

## 4. Envio de mensagem não é atômico — nunca retry cego

O fluxo outbound cruza: insert no banco → chamada UltraMSG → ACK webhook.  
Se qualquer passo falhar, a mensagem fica em estado `incerta` ou `pending`.

```js
// ❌ ERRADO — retry simples
if (error) await sendMessage(payload); // pode duplicar

// ✅ CORRETO
// Usar referenceId/client_temp_id para idempotência
// Verificar no provider se a mensagem já foi enviada antes de reenviar
// O reconciliador (`pendingOutboundReconciliationService.js`) cuida disso automaticamente
```

**Consequência real:** mensagem duplicada enviada ao cliente final.

---

## 5. Socket.IO — listener por requisição = memory leak

```js
// ❌ ERRADO — listener adicionado a cada requisição
app.get('/rota', (req, res) => {
  io.on('connection', (socket) => { /* leak */ });
});

// ✅ CORRETO — listeners registrados uma única vez no boot, em index.js
```

**Regra:** todo listener Socket.IO vai em `index.js` ou `socket/internalChatSocket.js`. Nunca dentro de um controller ou handler de rota.

---

## 6. Schema.sql não é a fonte de verdade

```js
// ❌ ERRADO — consultar schema.sql para entender o banco
// Ele é uma fotografia desatualizada e PODE estar errado

// ✅ CORRETO
// 1. Ver migrations em supabase/migrations/ ordenadas por timestamp
// 2. Migration mais recente sobre o domínio = estado atual
// 3. Migration posterior que altera/remove um objeto substitui o anterior
```

**Armadilha específica:** `empresa_zapi` aparece em schema.sql e em migrations. As migrations de agosto explicitamente a **preservaram** como legado necessário. Não remover.

---

## 7. Chatbot replay — não disparar para mensagens antigas

**Problema real documentado:** o sistema de reentrega de inbound antigo rodava o chatbot + reabertura de conversa antes da deduplicação por `whatsapp_id`. Resultado: bot mandava boas-vindas sem o cliente ter falado nada.

**Regra:** ao processar webhooks inbound, a deduplicação por `whatsapp_id` (constraint único) deve acontecer **antes** de qualquer side effect (chatbot, reabertura, socket). Não inverter esta ordem.

---

## 8. Protecão de envio está desativada — não ativar sozinho

```js
// Em services/protecao/protecaoOrchestrator.js
const PROTECAO_DESATIVADA = true; // ← não mudar sem calibrar limites primeiro
```

**Consequência:** ativar sem calibrar os limites por empresa pode bloquear envio legítimo imediatamente em produção. Requer: definir limites nas empresas, testar em ambiente controlado, depois ativar.

---

## 9. Worker de Disparo tem 3 gates — todos precisam estar ligados

```bash
DISPARO_WORKER_ENABLED=true   # gate 1 — worker processa?
DISPARO_LIVE_ENABLED=true     # gate 2 — envio real ou simulado?
DISPARO_DRY_RUN=false         # gate 3 — dry run desligado?
```

**Armadilha:** mudar apenas um gate e achar que está tudo funcionando. Por padrão, todos estão desligados. Para envio real em produção, os três precisam ser alterados explicitamente.

---

## 10. Testes passam — mas não provam segurança de banco

```js
// tests/setup.js mocka o cliente Supabase globalmente
// Os testes unitários NÃO executam SQL real, NÃO testam RLS
// Uma query sem filtro company_id passa nos testes mas vaza dados em produção
```

**Regra:** ao adicionar query nova, além do teste unitário (que usa mock), adicionar verificação manual com dois tenants diferentes.

---

## 11. JWT em query string vai para logs (vulnerabilidade ativa)

O `middleware/logger.js` registra `req.originalUrl`. O `authBearerOrQuery` aceita JWT via `?access_token=...` no `/media/proxy`.

**Consequência:** JWT em query param aparece em logs. Não adicionar novos endpoints que aceitem auth por query string.

---

## 12. Heartbeat do Disparo expõe dados cross-tenant (vulnerabilidade ativa)

`disparoSaudeController.js` consulta `disparo_worker_heartbeat` sem filtro `company_id`. Qualquer admin de qualquer empresa pode ver hostname/pid/metadados operacionais de outras empresas.

**Regra:** não expandir este endpoint nem basear lógica de negócio nele sem primeiro adicionar isolamento por tenant.

---

## 13. PM2 tem instances: 1 — nunca aumentar sem Redis

`ecosystem.config.js` usa `instances: 1`. State em memória (rate limit, presença, locks, dedup rápido, schedulers) é local ao processo.

**Consequência de aumentar para >1 sem Redis:** schedulers rodam duplicados (envio duplicado), rate limits não compartilhados, presença fragmentada, emits socket não chegam a todos os usuários.

---

## 14. Migration precisam ser aplicadas antes do deploy

Quando uma feature nova depende de uma migration:
1. Aplicar migration no banco de produção primeiro
2. Depois fazer deploy do código
3. Nunca na ordem inversa — o código novo pode falhar ao encontrar colunas/tabelas ausentes

**Exemplo real:** busca com unaccent via RPC — a migration `20260810200000` precisava estar aplicada antes do deploy do backend que a usava.

---

## 15. Frontend tem docs próprios — não confundir

```
backend/docs/ai-handoff/   ← esta série (backend)
frontend/docs/ai-handoff/  ← série separada (frontend)
```

Ao trabalhar no frontend, ler `frontend/docs/ai-handoff/00-LEIA-PRIMEIRO.md`, não os docs do backend.

---

## 16. `io` não existe no escopo — pegar de `req.app.get('io')`

**Armadilha:** copiar `if (io) emitirConversaAtualizada(...)` de outro handler sem declarar `const io = req.app.get('io')`.

Em `atualizarNomeContato` / `vincularClienteConversa` isso gerava `ReferenceError` **depois** do UPDATE no banco: a API voltava 500 (`Erro ao atualizar nome do contato`) e o frontend não pintava o nome novo, embora o cache já tivesse gravado.

```js
// ❌ ERRADO
if (io) emitirConversaAtualizada(io, company_id, conversa_id, payload)

// ✅ CORRETO
const io = req.app?.get?.('io') || null
if (io) emitirConversaAtualizada(io, company_id, conversa_id, payload, { skipAtualizarConversa: true })
```

Falha de emit **não** pode virar 500 depois que o nome já foi persistido.

---

## 17. Nome importado não se protege com score de `nomeSource`

**Armadilha:** subir `SOURCE_SCORE.import` para “ganhar” do WhatsApp. O nome atual é comparado como `nome_existente` (70); `syncUltramsg`/`name` (110) continuam a sobrescrever. A defesa é persistente: `clientes.nome_protegido` + `nome_origem` (`import_planilha` | `manual`) e o trigger `trg_proteger_nome_cliente`. Fontes automáticas não enviam `nome_override`.

---

## 18. Foto de perfil — nunca usar formato de ENVIO nem `payload.photo`

**CONFIRMADO (2026-08-28):** `toZapiSendFormat` / `phoneToChatId` inserem o 9º dígito em qualquer 12 dígitos. Isso é certo para **enviar** mensagem a celular; para **consultar** foto (`GET /contacts/image`) busca outro JID. `possiblePhonesBR` também inventa o 9 em fixo (2–5) e gravava a foto no contato errado.

```js
// ❌ ERRADO — formato de envio na foto
getProfilePicture(phone) // internamente phoneToChatId → sempre +9
possiblePhonesBR(fixo).forEach((p) => gravarFoto(p))

// ✅ CORRETO
profilePictureChatIdCandidates(phone) // JID real; celular 12↔13 só se o local for 6–9
possiblePhonesForWhatsappIdentity(phone) // não mistura fixo e celular
```

O webhook UltraMSG **não** traz foto de perfil. `payload.photo` numa mensagem de imagem é a mídia enviada. Só persistir URL vinda de `GET /contacts/image`.

---

## 19. ACK de campanha não pode exigir `disp-*` no body

**Armadilha:** só chamar `aplicarStatusDisparoFromWebhook` se `referenceId` começar com `disp-`.

A UltraMSG **quase nunca ecoa** o `referenceId` no `message_ack` (o mesmo vale para `crm-*` no chat). O ACK traz o id da mensagem. A fila precisa casar por `provider_message_id` e, se existir, `mensagem_id`. Sem isso o painel fica em **enviada** com ENTREGUES=0 mesmo quando o WhatsApp já entregou.

```js
// ❌ ERRADO
if (String(ref || '').startsWith('disp-')) aplicarStatusDisparoFromWebhook(...)

// ✅ CORRETO — todo ACK, com id do provedor + mensagem do chat
aplicarStatusDisparoFromWebhook({ referenceId: ref, providerMessageId: idStr, mensagemId: msg?.id, ... })
```

---

## 21. ACK de campanha — um pendente na empresa não serve para disparo

**Armadilha:** o fallback de `message_ack` com wamid só aplica se existir **exatamente 1** outbound pendente na empresa (últimos 5 min). No atendimento isso vale. Na campanha o 2º envio (outro contato, ~2 min depois) já vê 2 pendentes e o recibo é **ignorado**. A fila fica em **enviada** (provedor aceitou) sem virar **entregue**.

O send devolve id numérico; o ACK traz `true_5534…@c.us_SID`. Gravar o número em `whatsapp_id` impede o match exato.

```js
// ❌ ERRADO — whatsapp_id = "35096"; fallback global length === 1
whatsapp_id: messageId

// ✅ CORRETO
provider_queue_id: queueId numérico
whatsapp_id: só wamid real
// ACK: casar pendente na conversa cujo telefone está no wamid
```
