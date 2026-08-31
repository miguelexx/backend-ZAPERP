# ZapERP — Backend

API HTTP, webhooks **UltraMSG** e **Socket.IO** para o sistema de atendimento WhatsApp multi-tenant.

**Documentação canónica:** [`docs/README.md`](./docs/README.md) (índice mestre) · [`docs/AI_HANDOFF.md`](./docs/AI_HANDOFF.md) (contexto rápido para IAs) · [ADR — nomes legados](./docs/reference/ADR-LEGACY-NAMING.md)

## Requisitos

- Node.js 18+ (recomendado 20+)
- Supabase (PostgreSQL)
- Instância **UltraMSG** por empresa (credenciais em `empresa_zapi` — nome histórico da tabela; ver ADR)

## Configuração

1. Copie o ficheiro de exemplo e preencha as variáveis:
   ```bash
   cp .env.example .env
   ```
2. Edite `.env` com as chaves necessárias (`JWT_SECRET`, `APP_URL`, `WHATSAPP_WEBHOOK_TOKEN`, `SUPABASE_*`, `ULTRAMSG_*`, `CORS_ORIGINS`, …).
3. Instale dependências e inicie:
   ```bash
   npm install
   npm run dev
   ```

## Testes

```bash
npm test                     # Jest em série (~122 arquivos em 2026-08-31)
npm run test:watch           # Modo watch
```

Variáveis obrigatórias no ambiente de teste: `NODE_ENV=test`, `ZAPERP_DISABLE_BACKGROUND_JOBS=1`.  
Mocks em `tests/` para Supabase, provider, push, R2 e OpenAI — nunca usar serviços reais nos testes.

## Atualizar na VPS

Passo a passo: **[../docs/ATUALIZAR-NA-VPS.md](../docs/ATUALIZAR-NA-VPS.md)** (raiz do repositório).

Resumo: `git pull` → `npm install` (backend e frontend) → `npm run build` (frontend) → reiniciar processo (PM2 ou systemd).

---

## Deploy (checklist)

- [ ] `NODE_ENV=production`
- [ ] `APP_URL` = URL pública do backend
- [ ] `CORS_ORIGINS` = URL(s) do frontend
- [ ] `JWT_SECRET` forte
- [ ] `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY`
- [ ] `WHATSAPP_WEBHOOK_TOKEN` alinhado ao painel UltraMSG
- [ ] Credenciais por empresa em **`empresa_zapi`** (`instance_id`, `instance_token`, …) — ver doc oficial
- [ ] Webhook UltraMSG apontando para `https://<APP_URL>/webhooks/ultramsg?token=...`
- [ ] Proxy reverso com `TRUST_PROXY=1` se aplicável
- [ ] Não expor `/debug/env` em produção (desativado quando `NODE_ENV=production`)

## Endpoints principais (visão)

| Rota | Descrição |
|------|-----------|
| `GET /health` | Health check |
| `POST /usuarios/login` | Login (JWT) |
| `GET /chats` | Lista de conversas (autenticado) |
| `POST /webhooks/ultramsg` | Webhook **UltraMSG** (mensagens, acks) |
| `POST /webhooks/whatsapp` | Alias do mesmo webhook |

Integração autenticada: **`/integrations/whatsapp`** (e `/api/integrations/whatsapp`).

**Socket.IO:** `auth: { token }` (JWT com `company_id`). Salas: `empresa_{id}`, `conversa_{id}`, `usuario_{id}`, `departamento_{id}`.
