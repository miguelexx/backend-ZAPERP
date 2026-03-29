# Revisão Geral do Backend + Prompt para Validação no Frontend

> Atualização 2026-03-28: documento de revisão histórica. Referências a `webhookAuth`, Meta e Z-API devem ser interpretadas como legado; integração ativa atual é UltraMsg.

## 1. Resumo da Revisão Realizada

### 1.1 Estrutura Verificada

| Componente | Status | Observações |
|------------|--------|-------------|
| **index.js** | ✅ | Entry point, validação de env (JWT_SECRET, APP_URL, ZAPI_WEBHOOK_TOKEN, NODE_ENV), Socket.IO com auth JWT |
| **app.js** | ✅ | Express, Helmet, CORS, webhooks antes do CORS, rotas montadas corretamente |
| **Rotas** | ✅ | Todas as rotas conectadas aos controllers corretos |
| **Controllers** | ✅ | Funções exportadas e referenciadas corretamente |
| **Middleware** | ✅ | auth, adminOnly, rate limit, upload, webhookAuth funcionando |
| **Services** | ✅ | Integração Z-API, Meta, aiDashboardService, conversationSync |

### 1.2 Rotas Disponíveis (base URL: `/` ou `/api/`)

| Prefixo | Métodos | Autenticação | Exemplos |
|---------|---------|--------------|----------|
| `/dashboard` | GET, POST, PUT, DELETE | auth (adminOnly em algumas) | `/dashboard/overview`, `/dashboard/metrics`, `/dashboard/departamentos` |
| `/jobs` | GET, POST | auth/cron | `/jobs/timeout-inatividade` |
| `/ia` | GET, PUT, POST, DELETE | auth | `/ia/config`, `/ia/regras`, `/ia/logs` |
| `/ai` | POST | auth | `/ai/ask` |
| `/config` | GET, PUT, POST | auth (adminOnly) | `/config/empresa`, `/config/planos` |
| `/integrations/zapi` | GET, POST | auth | `/integrations/zapi/status`, `/integrations/zapi/connect/qrcode` |
| `/clientes` | GET, POST, PUT, DELETE | auth | `/clientes`, `/clientes/:id` |
| `/usuarios` | GET, POST, PUT, DELETE | auth (adminOnly em criar/editar) | `/usuarios`, `/usuarios/login` |
| `/chats` | GET, POST, PUT, DELETE | auth | `/chats`, `/chats/:id`, `/chats/:id/mensagens` |
| `/tags` | GET, POST, PUT, DELETE | auth | `/tags` |

### 1.3 Webhooks (sem CORS, rate-limited)

| Endpoint | Método | Descrição |
|----------|--------|-----------|
| `/webhook`, `/webhook/meta` | GET, POST | Meta WhatsApp Cloud API |
| `/webhooks/zapi`, `/webhook/zapi` | GET, POST | Z-API (health, connection, status, presence, disconnected) |

### 1.4 Melhorias Aplicadas

- **paginaMergeDuplicatas**: Já possui `auth` + `adminOnly` (apenas admins acessam)
- **apiPrefixes**: Inclui `/ai` e `/integrations` para SPA fallback não servir index.html em rotas de API
- **Rota /ai**: Montada tanto em `/ai` quanto em `/api/ai` para flexibilidade

---

## 2. Formato Padrão de Respostas da API

### Sucesso (200/201)
```json
{
  "ok": true,
  "data": { ... },
  "message": "opcional"
}
```

### Erro (4xx/5xx)
```json
{
  "error": "Mensagem de erro",
  "ok": false
}
```

### Autenticação
- **Header**: `Authorization: Bearer <JWT>`
- **Multi-tenant**: `x-company-id` (opcional, o JWT já contém `company_id`)

---

## 3. PROMPT PARA VALIDAÇÃO NO FRONTEND

Use o prompt abaixo no frontend (ou com o Cursor no projeto frontend) para garantir que todas as integrações estão corretas:

---

```
Faça uma validação completa da integração do frontend com o backend da plataforma WhatsApp. O backend expõe uma API REST em /api/* (ou diretamente em /dashboard, /chats, etc.) e WebSocket via Socket.IO.

## Checklist de Validação

### 1. Autenticação
- [ ] Login: POST /api/usuarios/login ou /usuarios/login com { email, senha } retorna { token, user, ... }
- [ ] Todas as requisições autenticadas usam header: Authorization: Bearer <token>
- [ ] Token inválido ou expirado retorna 401 com { error: "..." }
- [ ] Logout: limpar token do storage e redirecionar para login

### 2. Rotas Principais
Verifique que cada rota retorna o formato esperado:

| Rota | Método | Body (se POST) | Resposta esperada |
|------|--------|----------------|-------------------|
| /api/dashboard/overview | GET | - | { conversas, atendimentos, ... } |
| /api/dashboard/metrics | GET | - | { metricas, periodos, ... } |
| /api/dashboard/departamentos | GET | - | Array de departamentos |
| /api/chats | GET | - | Array de conversas |
| /api/chats/:id | GET | - | Objeto conversa com mensagens |
| /api/chats/:id/mensagens | POST | { texto } | Mensagem enviada |
| /api/chats/:id/assumir | POST | - | Conversa assumida |
| /api/chats/:id/encerrar | POST | - | Conversa encerrada |
| /api/chats/:id/transferir | POST | { departamento_id, usuario_id? } | Transferência ok |
| /api/chats/zapi-status | GET | - | { hasInstance, connected, configured } |
| /api/clientes | GET | - | Array de clientes |
| /api/usuarios | GET | - | Array de usuários (admin) |
| /api/tags | GET | - | Array de tags |
| /api/ia/config | GET | - | Configuração de IA |
| /api/ai/ask | POST | { question, period_days? } | { ok, intent, answer, data } |
| /api/integrations/zapi/status | GET | - | Status da instância Z-API |
| /api/integrations/zapi/connect/status | GET | - | Status de conexão |
| /api/integrations/zapi/connect/qrcode | POST | - | { qrcode, session } |

### 3. WebSocket (Socket.IO)
- [ ] Conexão: io.connect(url, { auth: { token } }) com token JWT
- [ ] Rooms: usuário entra em empresa_{id}, usuario_{id}, departamento_{id}
- [ ] Eventos a escutar: nova_mensagem, conversa_atualizada, status_mensagem, mensagens_lidas, typing_start, typing_stop
- [ ] Eventos a emitir: join_conversa, leave_conversa, typing_start, typing_stop
- [ ] Reconexão automática em caso de disconnect

### 4. Tratamento de Erros
- [ ] 401: redirecionar para login
- [ ] 403: mostrar "Sem permissão"
- [ ] 429: mostrar "Muitas requisições, aguarde"
- [ ] 500: mostrar mensagem genérica de erro
- [ ] Erros de rede: feedback ao usuário

### 5. Upload de Arquivos
- [ ] POST /api/chats/:id/arquivo com multipart/form-data, campo "file"
- [ ] Tipos permitidos: imagem, áudio, vídeo, documento
- [ ] Resposta: mensagem criada ou erro 400

### 6. CORS e Base URL
- [ ] Base URL configurável (ex: VITE_API_URL ou similar)
- [ ] Em dev: http://localhost:3000 (ou porta do backend)
- [ ] Em prod: URL do backend (ex: https://api.zaperp.wmsistemas.inf.br)
- [ ] Credentials: true nas requisições fetch/axios

### 7. Headers Obrigatórios
- [ ] Content-Type: application/json para POST/PUT com body JSON
- [ ] Authorization: Bearer <token> em rotas protegidas
- [ ] x-company-id: opcional (JWT já tem company_id)

## Ações
1. Revise cada serviço/API do frontend que chama o backend
2. Confirme que as URLs estão corretas (com ou sem /api conforme backend)
3. Verifique tratamento de erros e loading states
4. Teste fluxos críticos: login → listar conversas → abrir chat → enviar mensagem
5. Corrija qualquer inconsistência encontrada
```

---

## 4. Testes Rápidos (cURL)

```bash
# Health
curl -s http://localhost:3000/health

# Login
curl -s -X POST http://localhost:3000/api/usuarios/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@empresa.com","senha":"sua_senha"}'

# Com token (substitua TOKEN)
curl -s http://localhost:3000/api/dashboard/overview \
  -H "Authorization: Bearer TOKEN"
```

---

## 5. Variáveis de Ambiente do Backend

| Variável | Obrigatória | Descrição |
|----------|-------------|-----------|
| JWT_SECRET | Sim | Chave para assinatura JWT |
| APP_URL | Sim | URL pública do backend |
| ZAPI_WEBHOOK_TOKEN | Sim | Token para debug de webhooks |
| NODE_ENV | Sim | development ou production |
| SUPABASE_URL | Sim | URL do projeto Supabase |
| SUPABASE_SERVICE_ROLE_KEY | Sim | Service role key |
| CORS_ORIGINS | Não | Origens extras (vírgula) |
| WHATSAPP_PROVIDER | Não | zapi ou meta |
