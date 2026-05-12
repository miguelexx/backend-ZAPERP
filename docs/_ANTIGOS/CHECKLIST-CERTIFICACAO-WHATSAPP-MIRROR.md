# Checklist de Certificação — WhatsApp Web Mirror (Z-API)

## Objetivo
Provar que o sistema espelha corretamente mensagens, status e replies como o WhatsApp Web.

---

## 1) Enviar do CRM → Celular → Status atualiza ticks

**Passos:**
1. Enviar mensagem pelo CRM para um contato
2. Verificar que a mensagem aparece no celular
3. Aguardar webhook `DeliveryCallback` / `MessageStatusCallback`
4. Verificar que os ticks (✓✓) atualizam no CRM

**Critérios de sucesso:**
- `whatsapp_id` salvo na mensagem após envio
- Status: `pending` → `sent` (e opcionalmente `delivered` / `read`)
- Evento socket `status_mensagem` recebido
- Ícone de ticks atualiza no balão da mensagem

**Logs esperados:**
```
[Z-API] ▶ webhook recebido: { type: 'DeliveryCallback', fromMe: true, ... }
✅ Z-API status SENT → msg X (conversa Y)
```

---

## 2) Enviar do celular (fromMe) → aparece no CRM

**Passos:**
1. Enviar mensagem pelo celular para um contato
2. Verificar que a mensagem aparece no CRM na **mesma conversa** do contato
3. Nunca deve criar conversa do "meu número" ou conversa incorreta

**Critérios de sucesso:**
- Mensagem aparece com `direcao: 'out'`
- Mesma conversa do contato (telefone correto)
- Evento socket `nova_mensagem` recebido
- Log: `📤 Espelhamento: mensagem enviada pelo celular registrada no sistema`

**Logs esperados:**
```
[Z-API] resolveKey: { fromMe: true, resolvedKey: '...5534999999999', reason: 'fromMe destination to' }
✅ Mensagem salva no sistema: { conversa_id: X, direcao: 'out' }
```

---

## 3) Reply no celular citando mensagem do CRM

**Passos:**
1. No celular, responder (reply) a uma mensagem enviada pelo CRM
2. Verificar no CRM:
   - Mensagem recebida com `reply_meta` preenchido
   - `replyToId` = `whatsapp_id` da mensagem citada
   - Clicar na seta abre/scroll até a mensagem citada

**Critérios de sucesso:**
- `reply_meta.replyToId` salvo
- `reply_meta.snippet` com trecho da mensagem citada
- Frontend: clique na seta → scroll até mensagem + highlight

**Logs esperados:**
```
[Z-API] webhook payload { hasText: true, ... }
✅ Mensagem salva no sistema: { reply_meta: { replyToId: '...', snippet: '...' } }
```

---

## 4) Reply no CRM citando mensagem do cliente

**Passos:**
1. No CRM, responder (reply) a uma mensagem do cliente
2. Verificar que chega no celular como reply nativo
3. Verificar que o CRM salva `reply_meta` e `whatsapp_id`

**Critérios de sucesso:**
- Mensagem enviada com `replyMessageId` (whatsapp_id da citada)
- `whatsapp_id` salvo após envio
- `reply_meta` persistido no banco

---

## 5) Multi-tenant: dois tenants, sem vazamento

**Passos:**
1. Configurar duas instâncias Z-API (instanceId diferentes) para empresas diferentes
2. Enviar webhook com `instanceId` da empresa A
3. Verificar que apenas empresa A recebe a mensagem
4. Enviar webhook com `instanceId` da empresa B
5. Verificar isolamento

**Critérios de sucesso:**
- Cada webhook roteia por `instanceId` → `company_id` correto
- Log: `instance_not_mapped` quando instanceId não existe em `empresa_zapi`
- Nunca 401 por engano; sempre 200 quando instance não mapeado

**Logs esperados:**
```
[Z-API-WEBHOOK] {"eventType":"ReceivedCallback","instanceId":"...","companyIdResolved":123}
```
ou
```
[Z-API-WEBHOOK] {"eventType":"ReceivedCallback","instanceId":"...","companyIdResolved":"not_mapped"}
```

---

## Relatório final

Após os testes, preencher:

| Caso | Testado | OK | Observações |
|------|---------|-----|-------------|
| 1) CRM → Celular → Ticks | ☐ | ☐ | |
| 2) Celular (fromMe) → CRM | ☐ | ☐ | |
| 3) Reply celular → CRM | ☐ | ☐ | |
| 4) Reply CRM → Celular | ☐ | ☐ | |
| 5) Multi-tenant | ☐ | ☐ | |

**Data:** _______________  
**Ambiente:** _______________
