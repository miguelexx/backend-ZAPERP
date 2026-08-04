# WhatsApp via UltraMsg

O sistema utiliza **apenas UltraMsg** para integração com WhatsApp.

> **Documentação completa:** [ULTRAMSG-CONFIGURACAO-ENVIO.md](./ULTRAMSG-CONFIGURACAO-ENVIO.md) — formato de envio, API de mensagens, webhooks e certificação.

## Configuração

### 1. Variáveis de ambiente (.env)

```env
WHATSAPP_WEBHOOK_TOKEN=seu_token_seguro
ULTRAMSG_BASE_URL=https://api.ultramsg.com
ULTRAMSG_INSTANCE_ID=instance51534
ULTRAMSG_TOKEN=r6ztawoqwcfhzrd
APP_URL=https://sua-api.seudominio.com
```

### 2. Banco de dados (empresa_zapi)

A tabela `empresa_zapi` armazena credenciais UltraMsg (instance_id, instance_token). O webhook UltraMsg pode enviar `instanceId` como número (ex: "51534") ou com prefixo ("instance51534"); o backend aceita ambos e faz o mapeamento automaticamente.

Execute para configurar a instância:

```bash
node scripts/configurar-ultramsg.js 1
```

Ou insira manualmente:

```sql
INSERT INTO empresa_zapi (company_id, instance_id, instance_token, client_token, ativo)
VALUES (1, 'instance51534', 'r6ztawoqwcfhzrd', '', true)
ON CONFLICT (company_id) DO UPDATE SET
  instance_id = EXCLUDED.instance_id,
  instance_token = EXCLUDED.instance_token,
  client_token = '',
  ativo = true;
```

### 3. Webhook no painel UltraMsg

Configure no painel UltraMsg (Instance Settings → Webhook):

- **URL:** `https://SEU_APP_URL/webhooks/ultramsg?token=SEU_WHATSAPP_WEBHOOK_TOKEN`
- Ative: message_received, message_create, message_ack

### 4. Rotas de integração (frontend)

As rotas `/api/integrations/zapi/*` permanecem para compatibilidade:

- GET `/api/integrations/zapi/status`
- POST `/api/integrations/zapi/connect/qrcode`
- GET `/api/integrations/zapi/connect/status`

## Endpoints de webhook

| Rota | Uso |
|------|-----|
| POST /webhooks/ultramsg | Webhook principal UltraMsg |
| POST /webhooks/whatsapp | Alias para /webhooks/ultramsg |
| GET /webhooks/ultramsg/health | Health check |
