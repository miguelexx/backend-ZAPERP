# Checklist: Multi-tenant Z-API + Login

## Correções aplicadas

- [x] **Company 2 login corrigido via reset bcrypt**  
  Rota `POST /usuarios/resetar-senha-email` (auth, admin): recebe `{ email, nova_senha }`, normaliza email, gera bcrypt.hash e atualiza `usuarios.senha_hash`. Admin da empresa pode corrigir usuário criado "na mão" com senha inválida.

- [x] **Company 1 status/qr/recebimento usa empresa_zapi do banco**  
  `getEmpresaZapiConfig(company_id)` busca apenas `ativo=true`; `getStatus`/`getQrCodeImage` usam credenciais do banco. Sem dependência de ENV de instância.

- [x] **Webhooks roteiam por instanceId -> company_id**  
  `getCompanyIdByInstanceId(instanceId)` com fallback case-insensitive em `empresa_zapi.instance_id`. Extração robusta: `body.instanceId`, `body.instance_id`, `body.instance?.id`, `body.instance` (string).

- [x] **Sem dependência de env de instância em produção**  
  Remoção de ZAPI_INSTANCE_ID, ZAPI_TOKEN, ZAPI_CLIENT_TOKEN. Tudo via `empresa_zapi`.

- [x] **Sem vazamento de tokens**  
  Endpoints debug retornam `tokensMasked: true`; nunca `instance_token` ou `client_token`. Log de login falho (DEV) não expõe dados sensíveis.

## Rotas adicionadas

| Rota | Método | Auth | Descrição |
|------|--------|------|-----------|
| `/usuarios/resetar-senha-email` | POST | admin | `{ email, nova_senha }` — reset por email (mesma empresa) |
| `/api/integrations/zapi/debug-config` | GET | JWT | `{ company_id, hasInstance, ativo, instance_id, tokensMasked }` |
| `/api/integrations/zapi/debug-status` | GET | JWT | `{ connected, smartphoneConnected, needsRestore, error }` |
| `/webhooks/zapi/health` | GET | público | `{ ok: true }` |

## Token do webhook (ZAPI_WEBHOOK_TOKEN)

Aceito via:
- Header `X-Webhook-Token: <token>`
- Header `Authorization: Bearer <token>`
- Query `?token=<token>` (para URLs no painel Z-API)

## Script de teste

```bash
# Company 1
export COMPANY1_EMAIL="user1@empresa1.com"
export COMPANY1_SENHA="senha123"

# Company 2 (se 401, admin reseta)
export COMPANY2_EMAIL="user2@empresa2.com"
export COMPANY2_SENHA="senha123"
export ADMIN_EMAIL="admin@empresa2.com"
export ADMIN_SENHA="admin123"

# Webhook
export INSTANCE_ID_C1="instance_id_empresa_1"  # de empresa_zapi
export ZAPI_WEBHOOK_TOKEN="seu_token"
export BASE_URL="http://localhost:3000"

node scripts/test-multi-tenant-zapi.js
```

## Log de diagnóstico (DEV)

Em `NODE_ENV !== production`, falhas de login logam no console (sem expor ao client):
- `user_not_found` — email não existe
- `inactive` — usuário inativo
- `hash_invalid` — senha_hash não bcrypt ou ausente
- `bcrypt_mismatch` — senha incorreta
- `no_company_id` — usuário sem empresa
