# ZapERP — Documentação oficial (backend)

Base documental **canónica** do projeto **ZapERP / whatsapp-plataforma**, alinhada ao **código e migrações atuais**.  
Material em `backend/docs/_ANTIGOS/` é **histórico**; não usar como fonte de verdade sem validar no repositório.

---

## Objetivo do sistema

Plataforma **multi-tenant** de atendimento ao cliente via **WhatsApp**, com:

- Conversas, mensagens, estados de atendimento e departamentos  
- Chatbot, regras automáticas, respostas rápidas e jobs em background  
- Integrações auxiliares (CRM, chat interno, produtos, impressão, push, supervisão) conforme rotas montadas em `backend/app.js`

O provider WhatsApp **oficial e único** no runtime é **UltraMSG** (`services/providers/ultramsg.js`).

---

## Stack principal (verificado)

| Camada | Tecnologia |
|--------|------------|
| Backend | Node.js, Express 4, `express-async-errors`, `helmet`, `cors`, `express-rate-limit`, `multer` |
| Auth API | JWT (`jsonwebtoken`) |
| Validação | Zod |
| Base de dados | PostgreSQL via **Supabase** (`@supabase/supabase-js`) |
| Realtime servidor | **Socket.IO** 4.x |
| WhatsApp | **UltraMSG** (REST + webhook) |
| Outros serviços (deps) | OpenAI SDK, Firebase Admin, MSSQL (`mssql`), Web Push, ExcelJS, PDFKit, `ffmpeg-static`, `pg` |

**Frontend (repositório):** conforme `frontend/package.json` — **React 18**, **Vite 5**, **React Router 6**, **Zustand**, **socket.io-client** 4.x, **axios**, **@tanstack/react-virtual**, **@dnd-kit/***, PWA (`vite-plugin-pwa`). O backend pode servir o build estático `frontend/dist` quando existir (`app.js`).

---

## Arquitetura resumida

```
Cliente (browser / app)
    │  HTTPS REST + JWT
    ▼
Express (app.js) — CORS, Helmet, rotas /api, /chats, /integrations/whatsapp, …
    │
    ├─► Supabase (PostgreSQL) — dados por company_id
    ├─► UltraMSG API — envio de mensagens
    └─► Socket.IO (index.js) — rooms empresa_*, conversa_*, usuario_*

UltraMSG (cloud)
    │  POST webhook
    ▼
/webhooks/ultramsg (+ alias /webhooks/whatsapp) — antes do CORS
    └─► persistência + emissão Socket.IO
```

---

## Multi-tenant

- **`company_id`** obrigatório no JWT da API (`middleware/auth.js`) e no token do Socket (`index.js`).  
- Webhooks: `instanceId` → `company_id` via `resolveWebhookCompany` + `whatsappConfigService`.  
- Queries de negócio devem sempre filtrar por empresa.

---

## Organização do repositório (backend)

| Pasta / ficheiro | Função |
|------------------|--------|
| `app.js` | Express: segurança, webhooks, CORS, rotas, estáticos, SPA opcional |
| `index.js` | HTTP server + Socket.IO + worker de jobs |
| `routes/` | Definição de rotas por domínio |
| `controllers/` | Orquestração HTTP; inclui `webhookUltramsgController` e núcleo legado `webhookZapiController` |
| `services/` | Lógica de negócio, providers, filas, integrações |
| `middleware/` | Auth, rate limit, webhook, upload, etc. |
| `socket/` | Extensões Socket.IO (ex.: chat interno) |
| `helpers/` | Funções reutilizáveis |
| `config/` | Env, Supabase, uploads |
| `supabase/migrations/` | Evolução do schema PostgreSQL |
| `supabase/schema.sql` | **Referência** de contexto (aviso no ficheiro: não executar como script único) |

---

## Índice desta pasta

| Documento | Conteúdo |
|-----------|-----------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Camadas, rotas, auth, pastas, mensagens |
| [DATABASE.md](./DATABASE.md) | Tabelas, multi-tenant, índices (migrações + schema de referência) |
| [FLOWS.md](./FLOWS.md) | Fluxos ponta a ponta e diagramas textuais |
| [ULTRAMSG.md](./ULTRAMSG.md) | Contrato UltraMSG atual |
| [PERFORMANCE.md](./PERFORMANCE.md) | Boas práticas e anti-padrões |
| [PROJECT_RULES.md](./PROJECT_RULES.md) | Regras oficiais do projeto e do Cursor |
| [ADR-LEGACY-NAMING.md](./ADR-LEGACY-NAMING.md) | Nomes legados `zapi_*` / ficheiro `webhookZapiController` vs realidade UltraMSG; backlog seguro |

**Complementos na raiz `backend/docs/`:** contratos de API (`API-*.md`, `CRM-API.md`), `FEATURE-FLAGS.md`, `CHATBOT-SETUP-GUIDE.md`, SQL sugerido (`PERFORMANCE-INDICES-SUGERIDOS.sql`).

---

## Fail-fast de arranque (`index.js`)

Exige no `.env`: `JWT_SECRET`, `APP_URL`, `WHATSAPP_WEBHOOK_TOKEN`, `NODE_ENV` (valores literais verificados no código).

---

## Legado (não arquitetura atual)

**Z-API**, **Meta Cloud API**, rotas **`/webhooks/zapi`**, **`/integrations/zapi`** como contrato público: **não** documentados aqui como ativos. O ficheiro `webhookZapiController.js` é **código interno** reutilizado após normalização UltraMSG — não implica provider Z-API exposto. Detalhe: [ADR-LEGACY-NAMING.md](./ADR-LEGACY-NAMING.md).
