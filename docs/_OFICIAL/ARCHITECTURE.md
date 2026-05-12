# Arquitetura do sistema — ZapERP

Documento baseado em **`backend/app.js`**, **`backend/index.js`**, **`backend/package.json`**, **`routes/`**, **`services/providers/`** e **`middleware/`**.  
Não descreve Z-API nem Meta como entrada ativa de produção.

---

## 1. Visão em camadas

```
┌─────────────────────────────────────────────────────────┐
│  Cliente (SPA React/Vite + socket.io-client + axios)   │
└───────────────────────────┬─────────────────────────────┘
                            │ HTTPS / WSS
┌───────────────────────────▼─────────────────────────────┐
│  Express (app.js)                                         │
│  - Helmet, CSP, Permissions-Policy, requestId           │
│  - JSON + urlencoded (rawBody para assinaturas)         │
│  - Webhooks UltraMSG **antes** do CORS                  │
│  - CORS restrito a origens configuradas                 │
│  - Rotas REST + rate limit (apiLimiter / webhookLimiter)│
│  - /uploads estático (getUploadsRoot)                   │
│  - Opcional: servir frontend/dist + SPA fallback        │
└───────────────┬─────────────────────┬───────────────────┘
                │                     │
        ┌───────▼───────┐     ┌───────▼────────┐
        │  Controllers  │     │  Socket.IO     │
        │  + services   │     │  (index.js)    │
        └───────┬───────┘     └───────┬────────┘
                │                     │
        ┌───────▼─────────────────────▼────────┐
        │  Supabase (@supabase/supabase-js)    │
        │  PostgreSQL multi-tenant (company_id) │
        └───────────────────────────────────────┘
                │
        ┌───────▼────────┐
        │  UltraMSG API  │  ← único provider em getProvider()
        └────────────────┘
```

---

## 2. Backend — arranque e processo

| Ficheiro | Papel |
|----------|--------|
| `index.js` | `loadEnv()`, validações fail-fast, `http.createServer(app)`, Socket.IO `Server`, `internalChatSocket.attach(io)`, `app.set('io', io)`, `listen`, worker `queueManager.startWorker`, schedulers (`absenceFinalization`, `produtosSync`) |
| `app.js` | Define `express()`, segurança, **webhooks**, CORS, estáticos, health, rotas montadas |

---

## 3. Rotas HTTP principais (montagem real)

**Webhooks (sem JWT; com `webhookLimiter`):**

- `GET/POST` sob **`/webhooks/ultramsg`** → `webhookUltramsgRoutes`
- Alias **`/webhooks/whatsapp`** → mesmas rotas

**API (JWT em rotas protegidas; ver cada `routes/*`):**

Prefixos **`/`** e **`/api`** duplicam o mesmo conjunto de routers para compatibilidade SaaS (`api` aplica `apiLimiter` globalmente).

Domínios montados em `app.js` (nomes de pasta entre parênteses):

- `/dashboard` (`dashboardRoutes`)
- `/jobs` (`jobsRoutes`)
- `/ia`, `/ai` (`iaRoutes`, `aiRoutes`)
- `/config` (`configRoutes`)
- **`/integrations/whatsapp`** (`whatsappIntegrationRoutes`) — QR, status, sync, configure-webhooks, mensagens UltraMSG
- `/clientes` (`clienteRoutes`)
- `/usuarios` (`userRoutes`)
- `/chats` (`chatRoutes`) — mensagens, arquivos, reações, etc.
- `/tags` (`tagRoutes`)
- `/campanhas` (`campanhaRoutes`)
- `/opt-in`, `/opt-out`
- `/chatbot`, `/chatbot/debug`
- `/internal-chat` (`internalChatRoutes`)
- `/crm` (+ `apiLimiter`)
- `/supervisao`
- `/produtos`
- `/print` (+ `apiLimiter`)
- `/media` (+ `apiLimiter`)
- `/push` (+ `apiLimiter`)

**Páginas HTML servidas pelo backend:**

- `GET /permissoes` → `public/permissoes.html`
- `GET /painel-supervisao` → `public/supervisao.html`

**Health:**

- `GET /health`, `GET /health/detailed`

---

## 4. Autenticação

### 4.1 REST (`middleware/auth.js`)

- Header `Authorization: Bearer <JWT>`.
- `jwt.verify` com `JWT_SECRET`.
- **`company_id` numérico obrigatório** no payload; caso contrário `401` com log `TENANT_INCONSISTENT`.
- Normalização de **`departamento_ids`** (array) a partir de `departamento_id` legado.

### 4.2 Socket.IO (`index.js`)

- `socket.handshake.auth.token` — mesmo segredo JWT.
- Mesma exigência de **`company_id`** válido.
- `socket.user` preenchido com payload decodificado.

---

## 5. WebSocket / realtime

### 5.1 Servidor

- `socket.io` **4.7.5** com `transports: ['websocket', 'polling']`.
- CORS de socket: `CORS_ORIGINS` + origem derivada de `APP_URL`.

### 5.2 Salas (`index.js`)

| Sala | Uso |
|------|-----|
| `empresa_{company_id}` | Broadcast por tenant |
| `usuario_{user_id}` | Eventos direcionados ao utilizador |
| `departamento_{depId}` | Membro em todos os departamentos do token |
| `conversa_{conversaId}` | Após `join_conversa` autorizado |

### 5.3 Contrato de eventos (`io.EVENTS`)

Constantes definidas em código, incluindo (lista não exaustiva para integrações):

`nova_mensagem`, `status_mensagem`, `nova_conversa`, `conversa_atualizada`, `atualizar_conversa`, `contato_atualizado`, `mensagens_lidas`, `tag_adicionada`, `tag_removida`, `conversa_transferida`, `conversa_encerrada`, `conversa_reaberta`, `conversa_atribuida`, `crm:lead_updated`, `crm:kanban_refresh`.

Helpers: `io.emitEmpresa`, `io.emitConversa`, `io.emitUsuario`.

### 5.4 Chat interno

- `socket/internalChatSocket.js` — `attach(io)` e `handleConnection`.

### 5.5 Entrada na conversa

- Evento cliente **`join_conversa`**: validação `canUserJoinConversationRoom` (Supabase: `conversas`, `atendimentos`, perfil admin, atendente, departamento, transferência).
- **Idempotente:** só faz `join` e log se ainda não estava na room.
- `setImmediate` → `syncConversationContactOnJoin` (UltraMSG) ao abrir chat.

### 5.6 Typing

- `typing_start` / `typing_stop` reemitidos para a room `conversa_*` (exceto o emissor).

---

## 6. Fluxo de mensagens (alto nível)

### 6.1 Entrada (UltraMSG → sistema)

1. UltraMSG `POST` → `/webhooks/ultramsg` ou `/webhooks/whatsapp`.
2. Stack: `webhookLogger('ultramsg')` → `webhookBodyResolver` → `requireWebhookToken` → **`resolveWebhookCompany`** → `handleWebhookUltramsg`.
3. `resolveWebhookCompany` obtém `company_id` por `instanceId` (`getCompanyIdByInstanceId`). Sem mapeamento → `200` com `ignored` (não quebra o webhook).
4. `webhookUltramsgController` normaliza payload (`normalizeUltramsgToZapi`) e chama **`webhookZapiController.receberZapi`** ou **`statusZapi`** — **ficheiro legado por nome**, função atual = núcleo de persistência/atualização de estado.

### 6.2 Persistência

- Escrita em tabelas PostgreSQL via cliente Supabase nos serviços/controllers (ex.: `mensagens`, `conversas`, `clientes` — ver [DATABASE.md](./DATABASE.md)).

### 6.3 Saída para clientes

- Controllers/services obtêm `req.app.get('io')` ou padrão equivalente e emitem para `empresa_*` / `conversa_*` conforme implementação existente.

### 6.4 Envio (sistema → UltraMSG)

- `getProvider()` em `services/providers/index.js` devolve **apenas** `ultramsg`.
- `chatController` (e outros) usam métodos do provider (texto, mídia, etc.) com credenciais por **`company_id`** via `getEmpresaWhatsappConfig` / `empresa_zapi`.

---

## 7. Providers WhatsApp

| Ficheiro | Função |
|----------|--------|
| `services/providers/index.js` | `getProvider()` → `ultramsg` |
| `services/providers/ultramsg.js` | REST `api.ultramsg.com`, limites de body/caption, delays, `configureWebhooks`, envio/receção auxiliar |

**Tabela de credenciais:** `empresa_zapi` (nome histórico; contém `instance_id`, `instance_token`, … por `company_id`).

---

## 8. Serviços e controllers (organização)

- **`services/`** — regras de negócio, integração UltraMSG, filas (`queueManager`), CRM, chatbot, sync, push, etc.
- **`controllers/`** — entrada/saída HTTP; devem delegar lógica pesada a services.
- **`repositories/`** — acesso a dados mais estruturado onde existir (ex.: chat interno, CRM).
- **`helpers/`** — telefone, conversas, timestamps, media URL, etc.

---

## 9. Frontend (referência)

- **Build:** Vite; estado **Zustand**; virtualização **@tanstack/react-virtual**; rotas **react-router-dom**.
- **Realtime:** `socket.io-client` alinhado à versão do servidor.
- UI alvo: experiência tipo **WhatsApp Web** (requisito de produto nas rules).

---

## 10. Segurança transversal

- **Helmet** sempre ativo; CSP ajustada a SPA + blob + WS.
- **Rate limiting** em API e webhooks.
- **Uploads:** `multer` com `fileFilter`; erros convertidos a JSON 400 no error handler global (`app.js`).
- **Trust proxy** quando `TRUST_PROXY=1` ou produção.

---

## 11. Jobs e background

- `services/queueManager.js` — worker iniciado em `index.js` (intervalo 5000 ms no código inspecionado), tipos de job em constantes (ex.: `sync_contatos`).
- Emissão Socket ao concluir sync: evento com nome legado **`zapi_sync_contatos`** (compatibilidade; provider atual UltraMSG).

---

## 12. O que não documentar como atual

Rotas públicas **Z-API** ou **Meta Cloud** como caminho principal de webhook — **ausentes** da montagem principal em `app.js` na versão analisada. Código legado com nomes `zapi` pode existir **internamente**; não confundir com provider externo.
