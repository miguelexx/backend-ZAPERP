# Análise das APIs Externas — Implementação vs Documentação

**Data:** 2025-03-13  
**Escopo:** UltraMsg, Meta WhatsApp Cloud API, OpenAI, Supabase

---

## 1. UltraMsg API (WhatsApp)

**Documentação:** https://docs.ultramsg.com/  
**Base URL:** `https://api.ultramsg.com/{instance_id}/`

### 1.1 Implementação correta

| Recurso | Endpoint | Implementação | Status |
|---------|----------|---------------|--------|
| Envio texto | POST /messages/chat | `token`, `to`, `body` (máx 4096 chars); `msgId` para reply | ✅ |
| Envio imagem | POST /messages/image | `token`, `to`, `image`, `caption` (máx 1024) | ✅ |
| Envio documento | POST /messages/document | `token`, `to`, `document`, `filename` (máx 255) | ✅ |
| Envio áudio | POST /messages/audio | `token`, `to`, `audio` | ✅ |
| Envio voice | POST /messages/voice | `token`, `to`, `audio` (codec opus) | ✅ |
| Envio vídeo | POST /messages/video | `token`, `to`, `video`, `caption` | ✅ |
| Envio sticker | POST /messages/sticker | `token`, `to`, `sticker` | ✅ |
| Envio vCard | POST /messages/vcard | `token`, `to`, `vcard` | ✅ |
| Envio localização | POST /messages/location | `token`, `to`, `address`, `lat`, `lng` | ✅ |
| Reação | POST /messages/reaction | `token`, `msgId`, `emoji` | ✅ |
| Deletar mensagem | POST /messages/delete | `token`, `msgId` | ✅ |
| Status instância | GET /instance/status | token em query | ✅ |
| QR Code | GET /instance/qrCode | token em query | ✅ |
| Restart | POST /instance/restart | token no body | ✅ |
| Config webhooks | POST /instance/settings | token, webhook_url, sendDelay, etc. | ✅ |
| Lista contatos | GET /contacts | token em query | ✅ |
| Foto perfil | GET /contacts/image | chatId, token em query | ✅ |
| Upload mídia | POST /media/upload | token, file (multipart) | ✅ |

### 1.2 Content-Type

- **Provider (`ultramsg.js`):** usa `application/x-www-form-urlencoded` para mensagens.
- **Documentação:** exemplos mostram "Request samples - Json"; não especifica tipo obrigatório.
- **Conclusão:** implementação com form-urlencoded está correta e é a forma mais segura para caracteres especiais (UTF-8, emoji, base64).

### 1.3 Formato do `instance_id`

- **Provider (`ultramsg.js`):** adiciona prefixo `instance` quando o id não começa com `instance` (ex: `51534` → `instance51534`).
- **`ultramsgIntegrationService.js`:** passou a usar a mesma normalização do provider para consistência.
- **Documentação UltraMsg:** o placeholder `{{instance_id}}` na URL pode ser numérico (`51534`) ou com prefixo (`instance51534`), dependendo do painel.

### 1.4 `instance/settings` — campo `webhook_message_reaction`

- **Implementação:** envia `webhook_message_reaction: true` em `configureWebhooks`.
- **Documentação oficial (instance/settings):** lista apenas `webhook_message_received`, `webhook_message_create`, `webhook_message_ack`, `webhook_message_download_media`.
- **Conclusão:** `webhook_message_reaction` pode ser suportado em versão mais recente da API. Se a API retornar erro, remover ou tratar como opcional.

---

## 2. Meta WhatsApp Cloud API (Graph API)

**Documentação:** https://developers.facebook.com/docs/whatsapp/cloud-api/  
**Base URL:** `https://graph.facebook.com/v{version}/{phone_number_id}/messages`

### 2.1 Versão da API

| Arquivo | Versão usada | Versão atual Graph API |
|---------|--------------|-------------------------|
| `webhookController.js` | v21.0 | v25.0 |
| `providers/meta.js` | v21.0 | v25.0 |

- **Correção aplicada:** atualizado de v18.0 para v21.0 (versão estável e suportada).

### 2.2 Estrutura de mensagens

- **Texto:** `messaging_product`, `to`, `type: 'text'`, `text: { body }` — ✅ conforme documentação.
- **Imagem:** `type: 'image'`, `image: { link, caption? }` — ✅.
- **Documento:** `type: 'document'`, `document: { link, filename? }` — ✅.
- **Áudio:** `type: 'audio'`, `audio: { link }` — ✅.
- **Reply:** `context: { message_id }` — ✅.

### 2.3 Variáveis de ambiente

- `WHATSAPP_TOKEN` ou `META_ACCESS_TOKEN`
- `PHONE_NUMBER_ID` ou `WHATSAPP_PHONE_ID`
- `META_APP_SECRET` (para verificação de webhook)

---

## 3. OpenAI API

**Documentação:** https://platform.openai.com/docs/api-reference  
**Uso:** Assistente IA do Dashboard (`aiDashboardService.js`)

### 3.1 Implementação

- **Cliente:** `openaiClient.js` usa `OpenAI` do pacote `openai` v6.
- **Modelo:** `gpt-4o-mini` (configurável via `AI_MODEL`).
- **Timeout:** 30 segundos.
- **Retries:** `maxRetries: 0` (controller trata fallback).

### 3.2 Verificação

- Uso de `client.chat.completions.create()` está alinhado à API atual.
- `gpt-4o-mini` é um modelo válido e suportado.
- Validação de `OPENAI_API_KEY` (comprimento, formato) está adequada.

---

## 4. Supabase

**Documentação:** https://supabase.com/docs  
**Uso:** banco de dados, autenticação, storage

### 4.1 Configuração

- **Cliente:** `@supabase/supabase-js` v2.
- **Variáveis:** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
- **Observação:** `.env.example` usa `SUPABASE_SERVICE_ROLE_KEY`; o código usa `supabaseServiceKey` mapeado dessa variável — ✅ consistente.

### 4.2 Uso

- Queries com `.from()`, `.select()`, `.eq()`, `.ilike()` seguem o padrão da documentação.
- Uso de `service_role` para operações server-side é adequado.

---

## 5. Resumo de ações recomendadas

| Prioridade | API | Ação | Status |
|------------|-----|------|--------|
| Média | Meta | Atualizar versão da Graph API de v18.0 para v21.0+ | ✅ Aplicado |
| Baixa | UltraMsg | Unificar normalização de `instance_id` entre provider e integration service | ✅ Aplicado |
| Baixa | UltraMsg | Confirmar suporte a `webhook_message_reaction` em instance/settings | Pendente |
| — | OpenAI | Manter implementação atual | OK |
| — | Supabase | Manter implementação atual | OK |

---

## 6. Referências

- [UltraMsg API](https://docs.ultramsg.com/)
- [Meta WhatsApp Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api/)
- [Graph API Versioning](https://developers.facebook.com/docs/graph-api/guides/versioning)
- [OpenAI API Reference](https://platform.openai.com/docs/api-reference)
- [Supabase JavaScript Client](https://supabase.com/docs/reference/javascript/introduction)
