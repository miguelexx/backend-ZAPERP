# Certificação: Seta de Visualização (Status de Mensagem) em Tempo Real

## Objetivo
Garantir que os ticks (✓ enviada, ✓✓ entregue, ✓✓ azul visualizada) atualizem em tempo real, sincronizados com a Z-API, tanto para mensagens enviadas pelo **sistema** quanto pelo **celular**.

---

## Fluxo Backend (Verificado)

### 1. Mensagem enviada pelo SISTEMA (CRM)

| Etapa | Componente | Ação |
|-------|------------|------|
| 1 | `chatController.enviarMensagemChat` | Insere mensagem (status: pending) |
| 2 | Socket | Emite `nova_mensagem` (frontend exibe ✓ cinza) |
| 3 | Z-API | Envia para WhatsApp |
| 4 | `chatController` | Atualiza status → `sent` ou `erro`, salva `whatsapp_id`, emite `status_mensagem` |
| 5 | Z-API webhook | DeliveryCallback / MessageStatusCallback (delivered, read) |
| 6 | `webhookZapiController` | `updateStatusByWaId` → emite `status_mensagem` |

**Rooms do socket:** `empresa_{id}`, `conversa_{id}`, `usuario_{autor_id}`

### 2. Mensagem enviada pelo CELULAR

| Etapa | Componente | Ação |
|-------|------------|------|
| 1 | Z-API webhook | ReceivedCallback (fromMe=true) com messageId |
| 2 | `webhookZapiController` | Insere mensagem, emite `nova_mensagem` |
| 3 | Z-API webhook | MessageStatusCallback / DeliveryCallback (delivered, read) |
| 4 | `webhookZapiController` | `updateStatusByWaId` → emite `status_mensagem` |

### 3. Arquivo enviado pelo SISTEMA

| Etapa | Componente | Ação |
|-------|------------|------|
| 1 | `chatController.enviarArquivo` | Insere mensagem, emite `nova_mensagem` |
| 2 | Z-API | Envia mídia |
| 3 | Em caso de **erro** | Atualiza status → `erro`, emite `status_mensagem` |
| 4 | Em caso de **sucesso** | Webhook ReceivedCallback reconcilia (atualiza `whatsapp_id`), emite `status_mensagem` |
| 5 | Status posteriores | MessageStatusCallback → `updateStatusByWaId` → emite `status_mensagem` |

---

## Payload do evento `status_mensagem`

```json
{
  "mensagem_id": 123,
  "conversa_id": 456,
  "status": "sent",
  "whatsapp_id": "3EB0XXXX..."
}
```

**Status canônicos:** `pending` | `sent` | `delivered` | `read` | `played` | `erro`

---

## Checklist de Certificação (Teste Manual)

### Mensagem de texto enviada pelo sistema
- [ ] Enviar mensagem pelo CRM → tick ✓ (sent) aparece em até 2s
- [ ] Aguardar entrega no celular do contato → tick ✓✓ (delivered)
- [ ] Contato abre a conversa no WhatsApp → tick ✓✓ azul (read)
- [ ] Atualização em tempo real sem recarregar a página

### Mensagem enviada pelo celular
- [ ] Enviar mensagem pelo celular conectado → aparece no CRM
- [ ] Status (delivered/read) atualiza quando o destinatário visualiza

### Arquivo enviado pelo sistema
- [ ] Enviar imagem/áudio/documento pelo CRM → tick ✓ (sent) ou ❌ (erro)
- [ ] Em caso de sucesso, delivered/read atualizam via webhook

### Frontend
- [ ] Socket conectado com `auth: { token }`
- [ ] `join_conversa` ao abrir o chat
- [ ] Escuta `status_mensagem` e atualiza por `mensagem_id` **e** `whatsapp_id`
- [ ] Exibe ticks corretos: pending ⏳, sent ✓, delivered ✓✓, read ✓✓ azul

---

## Pontos de Emissão no Backend

| Arquivo | Linha aprox. | Cenário |
|---------|--------------|---------|
| `chatController.enviarMensagemChat` | ~2290 | Envio texto: sent/erro |
| `chatController.enviarArquivo` | ~3115 | Envio mídia: erro |
| `webhookZapiController` | ~805, 926, 1002, 1182, 2105, 2344 | MessageStatusCallback, DeliveryCallback, reconciliação |

---

## Configuração Z-API

O painel Z-API deve ter configurado:
- **Webhook URL:** `APP_URL/webhooks/zapi` (ou `/webhook/zapi`)
- **Eventos:** Receber callbacks de status (MessageStatusCallback, DeliveryCallback, ReadCallback)
- **Token:** `ZAPI_WEBHOOK_TOKEN` no header ou query

---

## Conclusão

O backend está **certificado** para:
- Emitir `status_mensagem` em todos os cenários (texto, arquivo, sistema, celular)
- Incluir `whatsapp_id` no payload para deduplicação no frontend
- Emitir para empresa, conversa e usuário autor (garantir tempo real para quem enviou)

**Recomendação:** Testar em ambiente real com celular conectado e contato externo para validar o fluxo completo delivered → read.
