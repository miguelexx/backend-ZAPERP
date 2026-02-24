# ZapERP — Backend

API e WebSocket para o sistema de atendimento WhatsApp (Z-API / Meta).

## Requisitos

- Node.js 18+ (recomendado 20+)
- Conta Supabase
- Instância Z-API (ou Meta WhatsApp Cloud API)

## Configuração

1. Copie o arquivo de exemplo e preencha as variáveis:
   ```bash
   cp .env.example .env
   ```
2. Edite `.env` com suas chaves (JWT_SECRET, SUPABASE_*, ZAPI_*, APP_URL, CORS_ORIGINS).
3. Instale dependências e inicie:
   ```bash
   npm install
   npm run dev
   ```

## Atualizar na VPS

Passo a passo completo: **[docs/ATUALIZAR-NA-VPS.md](../docs/ATUALIZAR-NA-VPS.md)** (na raiz do repositório).

Resumo: `git pull` → `npm install` no backend e no frontend → `npm run build` no frontend → reiniciar o processo (PM2 ou systemd).

---

## Deploy (checklist)

- [ ] `NODE_ENV=production`
- [ ] `APP_URL` = URL pública do backend (ex.: https://api.seudominio.com)
- [ ] `CORS_ORIGINS` = URL do frontend (separadas por vírgula se houver mais de uma)
- [ ] `JWT_SECRET` forte (ex.: `openssl rand -hex 32`)
- [ ] Supabase: `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY`
- [ ] Z-API: `ZAPI_INSTANCE_ID`, `ZAPI_TOKEN`, `ZAPI_CLIENT_TOKEN`, `ZAPI_WEBHOOK_TOKEN`
- [ ] No painel Z-API, configurar webhooks (Ao receber, Ao enviar, Status, Conexão) com a URL: `{APP_URL}/webhooks/zapi`
- [ ] Proxy reverso (Nginx/Cloudflare) com `TRUST_PROXY=1` se usar
- [ ] Remover ou não expor `/debug/env` em produção (já desativado quando `NODE_ENV=production`)

## Endpoints principais

| Rota | Descrição |
|------|-----------|
| `GET /health` | Health check |
| `POST /usuarios/login` | Login (retorna token JWT) |
| `GET /chats` | Lista de conversas (autenticado) |
| `GET /chats/:id` | Detalhe da conversa e mensagens |
| `POST /webhooks/zapi` | Webhook Z-API (mensagens, status) |
| `POST /webhooks/zapi/status` | Status de mensagem (ticks) |

Socket.IO: autenticação via `auth: { token }`. Rooms: `empresa_{id}`, `conversa_{id}`, `usuario_{id}`.
