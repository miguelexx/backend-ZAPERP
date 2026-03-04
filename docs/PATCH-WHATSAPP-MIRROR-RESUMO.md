# Patch WhatsApp Web Mirror (Z-API) — Resumo das alterações

## Arquivos modificados

### 1. `controllers/webhookZapiController.js`
- **Reply picker**: adicionados `payload?.context?.messageId`, `payload?.context?.id`, `payload?.message?.context?.messageId`, `payload?.message?.context?.id` para cobrir mais formatos da Z-API
- **DeliveryCallback sem conteúdo**: quando `fromMe` e sem conteúdo, **nunca inserir** mensagem; apenas atualizar status se a mensagem existir, ou ignorar (continue)
- **Reconciliação LID→telefone**: ao atualizar `telefone` da conversa no DeliveryCallback, emite `conversa_atualizada` para o frontend atualizar a lista

### 2. `services/zapiIntegrationService.js`
- **getCompanyIdByInstanceId**: fallback case-insensitive agora usa `.ilike('instance_id', id)` em uma única query (mais eficiente que buscar 20 linhas)

### 3. `middleware/resolveWebhookZapi.js`
- Mantido retorno 200 com `ignored: 'instance_not_mapped'` quando `instanceId` não mapeado (sem 401)

### 4. `supabase/migrations/20260305000001_mensagens_company_whatsapp_unique.sql` (novo)
- Índice único `(company_id, whatsapp_id)` para idempotência multi-tenant

## Arquivos não modificados (já corretos)

- **chatController.js**: já salva `whatsapp_id` e `status` ao enviar mensagem via Z-API
- **empresa_zapi**: mapeamento `instanceId` → `company_id` já implementado
- **Mensagens**: índice `(conversa_id, whatsapp_id)` já existia
- **resolveConversationKeyFromZapi**: já prioriza destino (to, recipient) para `fromMe=true`

## Documentação criada

- **docs/FRONTEND-REPLY-SCROLL-TO-MESSAGE.md**: especificação do frontend para renderizar `reply_meta` e scroll-to-message
- **docs/CHECKLIST-CERTIFICACAO-WHATSAPP-MIRROR.md**: checklist de testes para certificação

## Como aplicar

1. Executar a nova migration no Supabase:
   ```sql
   -- Ou rodar o arquivo 20260305000001_mensagens_company_whatsapp_unique.sql
   ```

2. Reiniciar o backend

3. Implementar no frontend conforme `docs/FRONTEND-REPLY-SCROLL-TO-MESSAGE.md`

4. Executar o checklist em `docs/CHECKLIST-CERTIFICACAO-WHATSAPP-MIRROR.md`
