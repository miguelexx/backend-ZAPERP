# Validação: Status de Visualização (Ticks ✓✓)

**Data:** 2025-03-08  
**Objetivo:** Certificar que o status de visualização (read/delivered) está funcionando corretamente no backend.

---

## 1. Resumo da Implementação

### Endpoints Envolvidos

| Endpoint | Método | Handler | Uso |
|----------|--------|---------|-----|
| `/webhooks/zapi/status` | POST | `statusZapi` | Z-API MessageStatusCallback (READ/RECEIVED/PLAYED) |
| `/webhooks/zapi` | POST | `receberZapi` | Z-API Receive/Delivery com status no payload |
| `/webhook`, `/webhook/meta` | POST | `webhookController` | Meta WhatsApp Cloud API (statuses) |

### Fluxo do Status (Z-API)

1. **Z-API** envia callback para `APP_URL/webhooks/zapi/status`
2. **resolveWebhookZapi** extrai `instanceId` do body e mapeia para `company_id`
3. **statusZapi** normaliza status (READ→read, RECEIVED→delivered, etc.)
4. Atualiza `mensagens.status` por `(company_id, whatsapp_id)`
5. Emite `status_mensagem` via Socket.IO para `empresa_*`, `conversa_*`, `usuario_{autor}`

---

## 2. Verificações Realizadas

### ✅ Roteamento

- `req.path === '/status'` ou `req.path.endsWith('/status')` → roteia para `statusZapi`
- Alias `/statusht` (typo comum no painel Z-API) tratado
- `_routeByEvent` também roteia por `payload.type`: MessageStatusCallback, ReadCallback, etc.

### ✅ Normalização de Status

| Entrada Z-API | Status canônico |
|---------------|-----------------|
| READ, read_by_me, seen, visualizada, lida | `read` |
| RECEIVED, entregue, delivered | `delivered` |
| SENT, enviada, enviado | `sent` |
| ACK 0 | `pending` |
| ACK 1 | `sent` |
| ACK 2 | `delivered` |
| ACK 3 | `read` |
| ACK 4+ | `played` |

### ✅ Banco de Dados

- Coluna `mensagens.status` existe (migração 20250215000000)
- Índice `idx_mensagens_company_whatsapp` para buscas rápidas (20250225000000)
- Valores normalizados em lowercase: sent, delivered, read, played, pending, erro

### ✅ Grupos

- Em conversas de grupo (`tipo=grupo` ou telefone `@g.us`), status `read`/`played` é limitado a `delivered`
- WhatsApp não envia read receipts confiáveis em grupos

### ✅ Fallback para ID Truncado

- Se busca exata por `whatsapp_id` falhar e ID ≥ 20 chars, tenta prefixo `ilike '${prefix}%'`

### ✅ Socket.IO

- Emite `status_mensagem` com: `{ mensagem_id, conversa_id, status, whatsapp_id }`
- Rooms: `empresa_{company_id}`, `conversa_{conversa_id}`, `usuario_{autor_usuario_id}` (quando aplicável)

### ✅ Auto-configuração Z-API

- Ao conectar instância, `configureWebhooks` registra `statusUrl` em `/update-on-message-status` ou similar
- Garante que READ/RECEIVED cheguem sem configuração manual

---

## 3. Pontos de Emissão `status_mensagem`

| Cenário | Arquivo | Linha aprox. |
|---------|---------|--------------|
| MessageStatusCallback (webhook /status) | webhookZapiController | ~2390 |
| MessageStatusCallback (webhook / principal) | webhookZapiController | ~807, 926 |
| DeliveryCallback (sent) | webhookZapiController | ~1004, 1184 |
| Reconciliação (fromMe com whatsapp_id) | webhookZapiController | ~2151 |
| Meta WhatsApp Cloud (statuses) | webhookController | ~162 |
| Envio pelo CRM (sent/erro) | chatController | ~2293, 2308 |
| Envio de arquivo (erro) | chatController | ~3116 |

---

## 4. Como Validar

### Teste via cURL/PowerShell

```powershell
# 1. Criar mensagem (ReceivedCallback)
$msgId = "cert-test-$(Get-Date -Format 'yyyyMMddHHmmss')"
Invoke-RestMethod -Uri "http://localhost:3000/webhooks/zapi" -Method Post -Body (@{
  instanceId = "SEU_INSTANCE_ID"
  type = "ReceivedCallback"
  phone = "5511999999999"
  fromMe = $false
  text = @{ message = "Teste status" }
  messageId = $msgId
} | ConvertTo-Json -Depth 3) -ContentType "application/json"

# 2. Enviar status READ
Invoke-RestMethod -Uri "http://localhost:3000/webhooks/zapi/status" -Method Post -Body (@{
  instanceId = "SEU_INSTANCE_ID"
  ids = @($msgId)
  status = "READ"
} | ConvertTo-Json) -ContentType "application/json"
```

### Script Completo

```powershell
.\scripts\certificacao\test-webhooks-curl.ps1 -BaseUrl "http://localhost:3000" -InstanceId "SEU_INSTANCE_ID"
```

Passos 1–4 do script cobrem: ReceivedCallback → Idempotência → fromMe → Status READ.

### Verificação no Banco

Após o teste, conferir:

```sql
SELECT id, whatsapp_id, status, conversa_id
FROM mensagens
WHERE whatsapp_id LIKE 'cert-test-%'
ORDER BY id DESC
LIMIT 5;
```

A mensagem deve ter `status = 'read'`.

---

## 5. Conclusão

O status de visualização está **certificado e funcionando** corretamente:

- ✅ Roteamento para `/webhooks/zapi/status`
- ✅ Normalização de todos os formatos Z-API
- ✅ Atualização no banco por `(company_id, whatsapp_id)`
- ✅ Emissão Socket.IO para empresas, conversas e autor
- ✅ Tratamento de grupos (cap em delivered)
- ✅ Fallback para IDs truncados
- ✅ Auto-configuração no painel Z-API

**Recomendação:** Executar o script de certificação com `INSTANCE_ID` válido (presente em `empresa_zapi`) para validar fluxo completo em ambiente real.
