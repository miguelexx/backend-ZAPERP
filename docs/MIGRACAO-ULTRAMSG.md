# Migração Z-API → UltraMsg

## Resumo

O sistema foi migrado para suportar **UltraMsg** como provedor de WhatsApp. A tabela `empresa_zapi` continua sendo utilizada (instance_id, instance_token). O `client_token` pode ser vazio para UltraMsg.

## Configuração

### 1. Variáveis de ambiente (.env)

```env
WHATSAPP_PROVIDER=ultramsg
ULTRAMSG_BASE_URL=https://api.ultramsg.com
ZAPI_WEBHOOK_TOKEN=seu_token_seguro
```

### 2. Banco de dados (empresa_zapi)

Inserir ou atualizar o registro para sua empresa:

```sql
INSERT INTO empresa_zapi (company_id, instance_id, instance_token, client_token, ativo)
VALUES (1, 'instance51534', 'r6ztawoqwcfhzrdc', '', true)
ON CONFLICT (company_id) DO UPDATE SET
  instance_id = EXCLUDED.instance_id,
  instance_token = EXCLUDED.instance_token,
  client_token = EXCLUDED.client_token,
  ativo = EXCLUDED.ativo;
```

Substitua `company_id` pelo ID da sua empresa e use o `instance_id` e `instance_token` do painel UltraMsg.

### 3. Webhook no painel UltraMsg

1. Acesse o painel UltraMsg → Instance Settings
2. Configure **Webhook URL**: `https://SEU_APP_URL/webhooks/ultramsg?token=SEU_ZAPI_WEBHOOK_TOKEN`
3. Ative: message_received, message_create, message_ack

O backend também tenta configurar automaticamente ao conectar (se `configureWebhooks` for chamado).

### 4. Conexão do WhatsApp

O fluxo permanece o mesmo: Integrações → Conectar WhatsApp → Escanear QR Code.

## Endpoints

| Recurso              | Rota                              |
|----------------------|-----------------------------------|
| Status               | GET /api/integrations/zapi/status  |
| QR Code              | POST /api/integrations/zapi/connect/qrcode |
| Webhook (receber)    | POST /webhooks/ultramsg           |
| Health webhook       | GET /webhooks/ultramsg/health     |

## Diferenças Z-API vs UltraMsg

| Recurso           | Z-API      | UltraMsg                          |
|-------------------|------------|-----------------------------------|
| sendCall          | ✅         | ❌ (não suportado)                |
| getContacts       | ✅         | ❌ (retorna [])                   |
| getProfilePicture | ✅         | ❌ (retorna null)                |
| sendContact       | Nome+Phone | vCard (implementado)              |
| sendLink          | Preview    | Fallback para texto com URL       |

## Reverter para Z-API

Altere no .env:

```env
WHATSAPP_PROVIDER=zapi
```

E restaure os valores de `instance_id` e `instance_token` na tabela `empresa_zapi` para as credenciais Z-API.
