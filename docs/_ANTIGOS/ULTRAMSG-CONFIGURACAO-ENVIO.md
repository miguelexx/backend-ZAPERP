# UltraMsg — Configuração, Webhooks e Envio de Mensagens

Documentação oficial para integração WhatsApp via UltraMsg. Inclui configuração de webhooks, formato de envio certificado e API de listagem de mensagens.

---

## 0. Troubleshooting: mensagens não chegam / variáveis concatenadas

### Mensagens de grupos e contatos NÃO chegam (recebidas nem enviadas)

1. **Webhook URL no painel UltraMsg:** Acesse Instance Settings → Webhook URL e configure:
   ```
   https://SEU_DOMINIO/webhooks/ultramsg?token=SEU_WHATSAPP_WEBHOOK_TOKEN
   ```
   O token deve ser **exatamente** o valor de `WHATSAPP_WEBHOOK_TOKEN` no `.env` da VPS.

2. **Ativar webhooks no painel:** Marque `webhook_message_received` e `webhook_message_create` como **true**.

3. **Mapeamento instance_id:** A tabela `empresa_zapi` deve ter um registro com `instance_id` igual ao que o UltraMsg envia (ex: `51534` ou `instance51534`). O backend aceita ambos.

4. **Forçar configuração de webhooks:** Após conectar o WhatsApp, chame `POST /integrations/whatsapp/configure-webhooks` (com auth) ou abra a página de Integrações — o sistema configura automaticamente ao detectar conexão.

5. **Variáveis obrigatórias na VPS:** `APP_URL`, `WHATSAPP_WEBHOOK_TOKEN`, e `empresa_zapi` com `instance_id` e `instance_token` da instância UltraMsg.

### Mensagens enviadas pelo sistema mas que não chegam no WhatsApp

A API UltraMsg exige **`application/x-www-form-urlencoded`** no envio (não JSON). O provider está configurado para isso; em caso de falha, confira os logs no servidor.

### NODE_ENV concatenado no .env

Se aparecer no log: `NODE_ENV: productULTRAMSG_BASE_URL=...` ou similar, significa que **falta uma quebra de linha** entre variáveis no `.env`. Corrija assim:

```
# ❌ Errado (tudo na mesma linha):
NODE_ENV=productionULTRAMSG_BASE_URL=https://api.ultramsg.com

# ✅ Correto (cada variável em sua linha):
NODE_ENV=production

ULTRAMSG_BASE_URL=https://api.ultramsg.com
```

---

## 1. Configuração da instância (instance/settings)

### 1.1 Campos disponíveis

| Campo | Tipo | Descrição | Recomendado |
|-------|------|-----------|-------------|
| `sendDelay` | número | Atraso em **segundos** entre envios normais | 1–30 |
| `sendDelayMax` | número | Atraso em **segundos** quando fila tem 10+ mensagens (deve ser **≥** sendDelay) | 15–60 |
| `webhook_url` | string | URL base do webhook **com** `?token=...` | Ver §1.2 |
| `webhook_retries` | número | Tentativas de reenvio em caso de falha HTTP | 3 |
| `webhook_message_received` | boolean | Webhook para mensagens recebidas | true |
| `webhook_message_create` | boolean | Webhook para mensagens criadas (enviadas) | true |
| `webhook_message_ack` | boolean | Webhook para entrega/leitura (ACK) | true |
| `webhook_message_download_media` | boolean | Download automático de mídia recebida | true |
| `webhook_message_reaction` | boolean | Webhook para reações a mensagens | true |

### 1.2 Formato correto do webhook_url

```
https://SEU_APP/webhooks/ultramsg?token=SEU_WHATSAPP_WEBHOOK_TOKEN
```

**Exemplo:**
```
https://zaperpapi.wmsistemas.inf.br/webhooks/ultramsg?token=9f3a8c7e2d6b4f1a0c8e9b2d7a6f4c3e8b1d0f2a7c9e6b5d4f3a1c8e7b6d2f0
```

O `token` deve ser o valor de `WHATSAPP_WEBHOOK_TOKEN` no `.env` — usado para autenticar as requisições do UltraMsg ao backend.

### 1.3 Atenção: sendDelay vs sendDelayMax

- **sendDelay**: atraso normal entre cada envio.
- **sendDelayMax**: atraso **maior** quando a fila tem 10+ mensagens (evita flood).

⚠️ **Recomendação:** `sendDelayMax` deve ser **≥** `sendDelay`. Exemplo correto:
- `sendDelay: 1`, `sendDelayMax: 15` — OK
- `sendDelay: 30`, `sendDelayMax: 15` — config invertida; quando a fila enche, o delay diminuiria.

### 1.4 Exemplo de configuração completa (JSON)

```json
{
  "sendDelay": 1,
  "sendDelayMax": 15,
  "webhook_url": "https://zaperpapi.wmsistemas.inf.br/webhooks/ultramsg?token=SEU_TOKEN",
  "webhook_retries": 3,
  "webhook_message_received": true,
  "webhook_message_create": true,
  "webhook_message_ack": true,
  "webhook_message_download_media": true,
  "webhook_message_reaction": true
}
```

---

## 2. API de listagem de mensagens (GET /messages)

Receba mensagens enviadas no formato JSON via solicitações GET.

**Base URL:** `https://api.ultramsg.com/{instance_id}/messages`

| Parâmetro | Obrigatório | Descrição |
|-----------|------------|-----------|
| `token` | Sim | Token da instância |
| `page` | Não | Página (default 1) |
| `limit` | Não | Itens por página (máx 100, default 100) |
| `status` | Não | Filtro por status (ver abaixo) |
| `sort` | Não | `asc` ou `desc` (default) |

### Status disponíveis

| Valor | Significado |
|-------|-------------|
| (omitido) ou `all` | Todas as mensagens |
| `queue` | Mensagens na fila |
| `sent` | Enviadas com sucesso |
| `unsent` | Não enviadas |
| `invalid` | Inválidas |
| `expired` | Expiradas |

### Exemplos de URL

```
# Todas
/messages?token=r6ztawoqwcfhzrdc&page=1&limit=100

# Só enviadas
/messages?token=r6ztawoqwcfhzrdc&page=1&limit=100&status=sent

# Fila
/messages?token=r6ztawoqwcfhzrdc&page=1&limit=100&status=queue

# Não enviadas
/messages?token=r6ztawoqwcfhzrdc&page=1&limit=100&status=unsent

# Inválidas
/messages?token=r6ztawoqwcfhzrdc&page=1&limit=100&status=invalid

# Expiradas
/messages?token=r6ztawoqwcfhzrdc&page=1&limit=100&status=expired
```

---

## 3. Formato de envio de mensagens (certificado)

O backend envia mensagens via UltraMsg nos seguintes formatos. **Todos os endpoints exigem** `token` no body (o provider adiciona automaticamente).

### 3.1 Texto

**POST** `/{instance_id}/messages/chat`

```json
{
  "token": "r6ztawoqwcfhzrdc",
  "to": "+5534999999999",
  "body": "Texto da mensagem",
  "msgId": "opcional_id_para_reply"
}
```

| Campo | Obrigatório | Regras |
|-------|-------------|--------|
| `to` | Sim | Formato: `+55XXXXXXXXXXX` (individual) ou `120363...@g.us` (grupo) |
| `body` | Sim | UTF-8, emoji suportado; **máx 4096 caracteres** |
| `msgId` | Não | ID da mensagem para reply |

### 3.2 Imagem

**POST** `/{instance_id}/messages/image`

```json
{
  "token": "...",
  "to": "+5534999999999",
  "image": "https://... ou data:image/...;base64,...",
  "caption": "Legenda opcional"
}
```

- `image`: URL HTTP ou base64 | jpg, jpeg, gif, png, webp, bmp | **máx 16 MB**
- `caption`: máx **1024 caracteres**

### 3.3 Documento

**POST** `/{instance_id}/messages/document`

```json
{
  "token": "...",
  "to": "+5534999999999",
  "filename": "arquivo.pdf",
  "document": "https://... ou base64",
  "caption": "opcional"
}
```

- `filename`: obrigatório, máx 255 caracteres
- `document`: URL ou base64 | zip, xlsx, csv, txt, pptx, docx, pdf | **máx 30 MB**

### 3.4 Áudio

**POST** `/{instance_id}/messages/audio`

```json
{
  "token": "...",
  "to": "+5534999999999",
  "audio": "https://... ou base64"
}
```

- mp3, aac, ogg | máx 16 MB

### 3.5 Voice (áudio de voz / PTT)

**POST** `/{instance_id}/messages/voice`

```json
{
  "token": "...",
  "to": "+5534999999999",
  "audio": "https://... ou base64"
}
```

- Codec **opus** recomendado | máx 16 MB

### 3.6 Vídeo

**POST** `/{instance_id}/messages/video`

```json
{
  "token": "...",
  "to": "+5534999999999",
  "video": "https://... ou base64",
  "caption": "opcional"
}
```

- mp4, 3gp, mov | máx **32 MB**

### 3.7 Sticker

**POST** `/{instance_id}/messages/sticker`

```json
{
  "token": "...",
  "to": "+5534999999999",
  "sticker": "https://... ou base64"
}
```

### 3.8 Contato (vCard)

**POST** `/{instance_id}/messages/vcard`

```json
{
  "token": "...",
  "to": "+5534999999999",
  "vcard": "BEGIN:VCARD\nVERSION:3.0\nN:Nome;;;\nFN:Nome\nTEL;TYPE=CELL;waid=5511999999999:+5511999999999\nEND:VCARD"
}
```

### 3.9 Localização

**POST** `/{instance_id}/messages/location`

```json
{
  "token": "...",
  "to": "+5534999999999",
  "address": "Endereço ou nome do lugar",
  "lat": -23.5505,
  "lng": -46.6333
}
```

### 3.10 Reação

**POST** `/{instance_id}/messages/reaction`

```json
{
  "token": "...",
  "msgId": "id_da_mensagem_no_whatsapp",
  "emoji": "👍"
}
```

---

## 4. Formato do número (to)

| Tipo | Exemplo |
|------|---------|
| Individual BR | `+5534999999999` |
| Grupo | `120363012345678901@g.us` |

O provider converte automaticamente para este formato a partir de números locais (ex.: `34999999999` → `+5534999999999`).

---

## 5. Variáveis de ambiente (.env)

```env
# URL pública do backend
APP_URL=https://zaperpapi.wmsistemas.inf.br

# Token para validar webhooks
WHATSAPP_WEBHOOK_TOKEN=seu_token_seguro

# UltraMsg (opcional se usar empresa_zapi)
ULTRAMSG_BASE_URL=https://api.ultramsg.com
ULTRAMSG_INSTANCE_ID=instance51534
ULTRAMSG_TOKEN=r6ztawoqwcfhzrdc

# Configuração de webhooks (ao chamar configureWebhooks)
# sendDelay em segundos (default 1)
ULTRAMSG_SEND_DELAY=1
# sendDelayMax em segundos (default 15)
ULTRAMSG_SEND_DELAY_MAX=15
# Tentativas de reenvio do webhook em falha
ULTRAMSG_WEBHOOK_RETRIES=3
# Download automático de mídia
ULTRAMSG_WEBHOOK_DOWNLOAD_MEDIA=true
```

---

## 6. Roteamento no backend

| Fluxo | Rota | Controller |
|-------|------|------------|
| Envio de texto | POST /chats/:id/mensagens | chatController.enviarMensagemChat |
| Envio de mídia/arquivo | POST /chats/:id/arquivo | chatController.enviarArquivo |
| Envio de contato | POST /chats/:id/contatos | chatController.enviarContatoWhatsapp |
| Envio de localização | POST /chats/:id/localizacao | chatController.enviarLocalizacao |
| Webhook UltraMsg | POST /webhooks/ultramsg | webhookUltramsgController |

---

## 7. Certificação

Ver relatório de auditoria: [CERTIFICACAO-ULTRAMSG-DOCUMENTACAO.md](./CERTIFICACAO-ULTRAMSG-DOCUMENTACAO.md)

- [x] Formato `to` (individual e grupo) validado pelo provider
- [x] Body de texto limitado a 4096 caracteres
- [x] Caption limitada a 1024 caracteres
- [x] `token` injetado em todas as requisições
- [x] URL encoding de parâmetros quando necessário (base64, UTF-8)
- [x] Webhook com token na query para autenticação
