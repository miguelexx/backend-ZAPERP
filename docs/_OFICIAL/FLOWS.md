# Fluxos reais — ZapERP

Baseado em `webhookUltramsgRoutes.js`, `webhookUltramsgController.js`, `index.js` (Socket.IO), `services/providers/ultramsg.js`, `services/queueManager.js` e `middleware/resolveWebhookCompany.js`.

---

## Legenda

- **UltraMSG** = único provider HTTP externo de WhatsApp.
- **Núcleo interno** = `webhookZapiController` (nome legado; funções `receberZapi` / `statusZapi`).

---

## Fluxo A — Webhook UltraMSG (entrada)

```
UltraMSG
   │ POST JSON ou form (event_type, instanceId, data…)
   ▼
[/webhooks/ultramsg ou /webhooks/whatsapp]
   │
   ├─ webhookLogger('ultramsg')     → registo em webhook_logs (quando configurado)
   ├─ webhookBodyResolver         → normaliza corpo (ex.: payload string JSON)
   ├─ requireWebhookToken         → WHATSAPP_WEBHOOK_TOKEN (query/header/Bearer)
   ├─ resolveWebhookCompany
   │     └─ instanceId → company_id (empresa_zapi + whatsappConfigService)
   │        • sem instanceId → 200 ignored
   │        • sem mapping   → 200 ignored (não derruba o provider)
   ▼
handleWebhookUltramsg
   │
   ├─ message_ack / webhook_message_ack
   │     └─ normalizeUltramsgToZapi → statusZapi(req,res)
   │
   └─ message_received | message_create | webhook_message_* | message_reaction | …
         └─ normalizeUltramsgToZapi → receberZapi(req,res)
```

**Diagrama de decisão (simplificado):**

```
           +------------------+
           |  POST webhook    |
           +---------+--------+
                     |
           +---------v---------+
           | token válido?     |--no--> 401/403 conforme middleware
           +---------+---------+
                     | sim
           +---------v---------+
           | instanceId→      |
           | company_id       |--null--> 200 { ignored }
           +---------+---------+
                     | ok
           +---------v---------+
           | event_type?      |
           +--+-----------+---+
              |           |
         message_ack   mensagem
              |           |
              v           v
          statusZapi  receberZapi
```

**Respostas HTTP:** erros internos do handler tendem a responder **`200 { ok: true }`** para não gerar retries infinitos do UltraMSG em falhas transitórias (ver `catch` em `handleWebhookUltramsg`).

---

## Fluxo B — Normalização UltraMSG → núcleo interno

`normalizeUltramsgToZapi` (`webhookUltramsgController.js`):

- Extrai **`fromMe`**, JIDs `from` / `to`, grupo `@g.us`, **`messageId`** (prioriza `data.id` alinhado a acks).
- Monta URLs de **mídia** a partir de `data.media`, `audio`, `document`, etc.
- **Localização:** usa `lat`/`lng` ou objeto `location`; evita usar `body` Base64 como endereço.
- **Grupos:** preserva JID completo (inclui formato com hífen no meio do `@g.us`).

Objetivo: alimentar o mesmo pipeline de persistência que espera um shape “tipo callback” unificado.

---

## Fluxo C — Persistência e idempotência

- O núcleo **`receberZapi`** / serviços associados gravam **`mensagens`** com `whatsapp_id` quando existir.
- **Unicidade:** migrações criam índice único por `(conversa_id, whatsapp_id)` (ou variantes por `company_id` — ver [DATABASE.md](./DATABASE.md)).
- Atualiza **`conversas`** (`ultima_atividade`, contadores, estado de atendimento) conforme regra de negócio no controller/serviços.

*(Detalhe campo a campo: ler implementação em `webhookZapiController.js` e helpers — não duplicar aqui para evitar dessincronização.)*

---

## Fluxo D — Realtime para o frontend

```
Após INSERT/UPDATE bem-sucedido
        │
        ▼
req.app.get('io')  (ou io injetado)
        │
        ├── emitEmpresa(company_id, EVENT, payload)
        ├── emitConversa(conversa_id, EVENT, payload)
        └── emitUsuario(user_id, EVENT, payload)
```

**Contrato:** nomes em `io.EVENTS` (`index.js`) — o frontend deve subscrever os mesmos literais.

**Join de sala:**

1. Cliente autentica socket (JWT com `company_id`).
2. Servidor entra em `empresa_*`, `usuario_*`, `departamento_*`.
3. Cliente emite **`join_conversa`** → servidor valida permissão → `socket.join('conversa_'+id)`.
4. **`leave_conversa`** remove a room.

**Sincronização de contacto ao abrir chat:** `syncConversationContactOnJoin` (UltraMSG) disparada em `setImmediate` após join bem-sucedido.

---

## Fluxo E — Envio (painel → UltraMSG)

```
Cliente REST autenticado
   │  POST /chats/:id/mensagens (ou rota de mídia)
   ▼
chatController (+ middlewares em chatRoutes)
   │
   ├─ validações / permissões
   ├─ persistência otimista ou pós-confirmação (conforme método)
   └─ getProvider() → ultramsg.send* (sendText, sendImage, …)
```

- **Formato:** UltraMSG usa predominantemente **`application/x-www-form-urlencoded`** no provider (`ultramsg.js` comentários).
- **Anti-flood:** `ULTRAMSG_SEND_DELAY_MS` e delays por empresa em `lastSendPerCompany`.

---

## Fluxo F — Acks e status de mensagem

1. UltraMSG envia `message_ack` / `webhook_message_ack`.
2. Normalização mapeia `ack` numérico/string → `status` interno (`mapUltramsgAckToStatus`).
3. `statusZapi` atualiza **`mensagens.status`** e emite **`status_mensagem`** (e correlatos) via Socket.

---

## Fluxo G — Jobs em background (`queueManager`)

```
INSERT job (tipo sync_contatos, …)  →  tabela jobs
        │
        ▼
startWorker(polling) lê jobs pendentes
        │
        ├─ marca running / completed / failed
        └─ ao concluir sync de contatos:
               io.emit('zapi_sync_contatos', { … })   // nome legado do evento
```

**Socket:** literal **`zapi_sync_contatos`** ainda emitido em `queueManager.js` — frontend ou documentação de eventos devem tratar este nome como **evento de sistema**, não como “provider Z-API”.

---

## Fluxo H — fromMe e espelhamento

- **`fromMe: true`** — mensagem originada no número conectado (operador no telefone ou sistema, conforme payload UltraMSG).
- A normalização escolhe o JID de contacto vs. `to`/`from` para obter o telefone certo em conversa 1:1.
- Direção gravada em **`mensagens.direcao`** (`in` / `out`) no núcleo de processamento.

---

## Fluxo I — Mídia

1. Webhook pode trazer URL em `data.media` ou campos específicos por tipo.
2. `webhook_message_download_media` (configuração no UltraMSG) influencia presença de URL.
3. Download/armazenamento local segue lógica no núcleo / serviços de mídia (ver controllers e `getUploadsRoot`).

---

## Fluxo J — Reconexão Socket (cliente)

- Cliente **socket.io-client** com `transports: ['websocket','polling']` alinhado ao servidor.
- Reconexão automática do cliente Socket.IO; após reconnect, o cliente deve **reenviar** `join_conversa` para as threads abertas (padrão típico; confirmar implementação no frontend).

---

## Fluxo K — Notificações push (visão backend)

- Rotas `/push` em `app.js`; tabelas `push_subscriptions`, `push_tokens` (migrações).  
- Fluxo detalhado: ler `services/pushNotificationService.js` / `webPushDispatchService.js`.

---

## O que não fazer nestes fluxos

- Não assumir segundo webhook público paralelo sem verificar `app.js`.
- Não tratar documentação em `_ANTIGOS/` como especificação de payload — apenas o código e o painel UltraMSG.
