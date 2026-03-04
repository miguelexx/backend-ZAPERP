# Relatório de Auditoria: Login + JWT + Z-API Connect

**Data:** 04/03/2025  
**Escopo:** Login (bcrypt, JWT, company_id), Multi-tenant, Z-API Connect (status/QR/restart/phone-code)

---

## A) Login — Alterações e Validações

### Endpoint
- **Rota:** `POST /usuarios/login` e `POST /api/usuarios/login`
- **Arquivo:** `controllers/userController.js`, `routes/userRoutes.js`

### Validações confirmadas/corrigidas

| Item | Status |
|------|--------|
| Busca usuário por email (lower/trim) | ✅ Já implementado |
| Valida `ativo=true` | ✅ Já implementado |
| bcrypt.compare(senha, senha_hash) | ✅ Já implementado |
| Hash bcrypt válido (começa com `$2`) | ✅ **Adicionado** — retorna 401 genérico se inválido |
| JWT com user_id, company_id (INT), email, perfil | ✅ **Corrigido** — JWT agora inclui `user_id`, `company_id` como Number |
| Não vazar se usuário existe | ✅ Mensagem genérica "Credenciais inválidas" |

### Alterações mínimas feitas

1. **Validação de hash bcrypt** — Antes de `bcrypt.compare`, verifica se `senhaBanco.startsWith('$2')`. Caso contrário, retorna 401 com "Credenciais inválidas".

2. **Prioridade senha_hash** — Ordem de busca: `senha_hash` primeiro (coluna oficial do schema).

3. **JWT** — Inclusão de `user_id`, garantia de `company_id` como `Number(usuario.company_id)`.

---

## B) Multi-tenant (company_id)

### Auditoria

- **Nenhum endpoint** aceita `company_id` do frontend (body, query, headers).
- Todas as rotas Z-API e protegidas usam `req.user.company_id` do JWT.
- Middleware `auth.js`: valida JWT e **exige** `company_id` numérico > 0; retorna 401 "Tenant inválido" se ausente.
- `empresa_zapi`: query sempre com `.eq('company_id', company_id)`.
- `zapi_connect_guard`: idem.

---

## C) Z-API Connect — Status, QR, Restart, Phone-Code

### Contrato validado

| Endpoint | Método | Comportamento |
|----------|--------|---------------|
| `/integrations/zapi/connect/status` | GET | 200 com hasInstance, connected, smartphoneConnected, needsRestore, error, meSummary (sem tokens) |
| `/integrations/zapi/connect/qrcode` | POST/GET | 200 com qrBase64 ou connected; 409 needsRestore; 429 throttle/blocked |
| `/integrations/zapi/connect/restart` | POST | Reinicia e retorna status completo |
| `/integrations/zapi/connect/phone-code` | POST | Valida 10–13 dígitos BR, retorna code |

### Segurança

- **Nunca** logar URL completa da Z-API (contém `/token/{instance_token}/`).
- **Nunca** retornar `instance_token` ou `client_token` ao frontend.
- `buildMeSummary`: **restrito** a `id`, `name`, `due`, `paymentStatus`, `connected`, `phone` — removidas URLs que poderiam conter tokens.

---

## D) Scripts de Teste

### Scripts criados/atualizados

| Arquivo | Descrição |
|---------|-----------|
| `scripts/test-login-and-zapi.js` | Teste Node: login → JWT → status → qrcode (1ª e 2ª) → phone-code inválido |
| `scripts/test-login-and-zapi.ps1` | Wrapper PowerShell |
| `scripts/test-login-and-zapi.sh` | Wrapper Bash |
| `scripts/test-zapi-connect.ps1` | Existente — testes de connect com TOKEN |
| `scripts/test-zapi-connect.sh` | Existente |

### Como executar

**Com login (email/senha):**
```powershell
$env:LOGIN_EMAIL="admin@empresa.com"
$env:LOGIN_SENHA="sua_senha"
.\scripts\test-login-and-zapi.ps1
```

**Com token existente:**
```powershell
$env:TOKEN="eyJ..."
.\scripts\test-login-and-zapi.ps1
```

**Bash:**
```bash
LOGIN_EMAIL=admin@empresa.com LOGIN_SENHA=senha ./scripts/test-login-and-zapi.sh
```

### O que o script verifica

1. `POST /api/usuarios/login` → 200 e token com `company_id` no payload.
2. `GET /connect/status` → 200, sem vazamento de tokens.
3. `POST /connect/qrcode` (1ª) → 200 ou 404/429 conforme cenário.
4. `POST /connect/qrcode` (2ª imediata) → esperado 429 (throttle).
5. `POST /connect/phone-code` com phone inválido → 400.
6. Nenhuma resposta contém `instance_token` ou `client_token`.

---

## Arquivos modificados (diff resumido)

| Arquivo | Alterações |
|---------|------------|
| `controllers/userController.js` | Validação hash bcrypt (`$2`), prioridade `senha_hash`, JWT com `user_id` e `company_id` numérico |
| `services/zapiIntegrationService.js` | `buildMeSummary` reduzido a campos seguros (sem URLs com tokens) |
| `scripts/test-login-and-zapi.js` | Novo |
| `scripts/test-login-and-zapi.ps1` | Novo |
| `scripts/test-login-and-zapi.sh` | Novo |

---

## Checklist final

- [x] Login funciona com bcrypt + credenciais válidas
- [x] JWT contém `company_id` correto (INT)
- [x] Rotas `/integrations/zapi/connect/*` usam `req.user.company_id`
- [x] Multi-tenant: nenhum endpoint aceita `company_id` do frontend
- [x] Sem vazamento de tokens em responses ou logs
- [x] Scripts de teste criados e documentados

---

## Executar testes manualmente

1. Iniciar o backend: `npm run dev` ou `node index.js`
2. Garantir usuário no banco com `senha_hash` bcrypt válido (começa com `$2`).
3. Rodar: `node scripts/test-login-and-zapi.js` com `LOGIN_EMAIL` e `LOGIN_SENHA` definidos.
