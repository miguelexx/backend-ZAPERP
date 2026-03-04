# Z-API Multi-tenant

O backend utiliza **sempre** credenciais da tabela `empresa_zapi` por `company_id`. Nenhuma rota autenticada ou webhook usa ENV para instância fixa.

## Rotas autenticadas

- `company_id` vem de `req.user.company_id` (JWT)
- Carrega credenciais: `SELECT * FROM empresa_zapi WHERE company_id = ? AND ativo = true`
- Se não houver registro: `hasInstance=false` ou 404
- URLs: `{ZAPI_BASE_URL}/instances/{instance_id}/token/{instance_token}/...`
- Header: `Client-Token: {client_token}`

## Webhooks (POST /webhooks/zapi, /status, /connection, /presence)

- `company_id` resolvido por `instanceId` do payload:
  ```sql
  SELECT company_id FROM empresa_zapi
  WHERE instance_id = payload.instanceId AND ativo = true
  ```
- Se não mapeado: responde 200 e loga "instance not mapped"
- Para `/webhooks/zapi/status` sem `instanceId`: tenta derivar pela mensagem (`whatsapp_id` → `mensagens.company_id`)

## ENV

| Variável | Obrigatório | Uso |
|----------|-------------|-----|
| ZAPI_BASE_URL | Sim | Base da API Z-API |
| ZAPI_WEBHOOK_TOKEN | Sim | Validação de webhook (opcional em config) |
| ZAPI_INSTANCE_ID | Não | Fallback DEV apenas; em prod causa "multi-tenant required" |
| ZAPI_TOKEN | Não | Idem |
| ZAPI_CLIENT_TOKEN | Não | Idem |
| WEBHOOK_COMPANY_ID | **Removido** | Nunca mais usado |

## Segurança

- URL completa com token **nunca** logada
- Tokens **nunca** retornados ao frontend
- Todas as queries filtram por `company_id`

## Teste multi-tenant

1. Inserir dois registros em `empresa_zapi` com `company_id` diferentes e `instance_id` diferentes
2. Login como usuário da empresa A → `GET /integrations/zapi/connect/status` → instância A
3. Login como usuário da empresa B → mesma rota → instância B
4. Webhook com `instanceId` de A → grava em `company_id` A
5. Webhook com `instanceId` de B → grava em `company_id` B
