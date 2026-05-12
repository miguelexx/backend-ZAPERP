# Teste manual: espelhamento WhatsApp (mensagens do celular no ZapERP)

Objetivo: garantir que **todas** as mensagens recebidas no WhatsApp (incluindo as enviadas pelo próprio celular do dono do número) apareçam no sistema em tempo real e sejam persistidas.

## Pré-requisitos

- Backend rodando com Z-API configurada
- **ZAPI_CLIENT_TOKEN** no `.env` (obrigatório para a API configurar webhooks e ativar notifySentByMe)
- Webhook Z-API apontando para `{APP_URL}/webhooks/zapi`
- **notifySentByMe ativado** — ao subir o backend, o log deve mostrar: `✅ Z-API notifySentByMe ativado: mensagens enviadas pelo celular serão enviadas ao webhook`. Se não aparecer, ative manualmente no painel Z-API a opção "Notificar mensagens enviadas por mim".
- Frontend aberto (lista de conversas + um chat aberto) com WebSocket conectado
- Opcional: `WHATSAPP_DEBUG=true` no `.env` para ver logs de payload e DROPPED

## Passo a passo

### a) Mensagem enviada pelo CELULAR (dono do número) para um contato

1. No **celular** conectado ao mesmo número da instância Z-API, abra o WhatsApp e envie uma mensagem de texto para qualquer contato (ex.: "Teste espelho").
2. **Esperado:**
   - O webhook recebe o POST (verificar logs: `📩 Z-API mensagem recebida: ... (enviada por nós)` ou `📤 Espelhamento: mensagem enviada pelo celular registrada no sistema`).
   - No **banco**: tabela `mensagens` ganha um registro com `direcao = 'out'`, `whatsapp_id` preenchido, `conversa_id` da conversa correta.
   - No **front**: a mensagem aparece na bolha do chat em tempo real (evento `nova_mensagem` via Socket.IO) e na lista a conversa sobe com a última mensagem.
3. Se **não** aparecer:
   - Ative `WHATSAPP_DEBUG=true` e reinicie o backend.
   - Envie de novo do celular e confira os logs: `[Z-API] webhook payload` (eventType, fromMe, to, chatId) e se houver `[Z-API] DROPPED: no phone`, o payload não tinha phone/JID utilizável; as alterações de `pickBestPhone` e `getFallbackPhoneForFromMe` devem reduzir esse caso.

### b) Mensagem enviada pelo CONTATO para o número (entrada)

1. De outro número (ou do mesmo em outro aparelho), envie uma mensagem **para** o número da instância.
2. **Esperado:**
   - Webhook recebe; mensagem gravada com `direcao = 'in'`.
   - Contador de não lidas da conversa incrementa.
   - Front recebe `nova_mensagem` e `atualizar_conversa`; mensagem aparece e conversa fica com indicador de não lida.

### c) Verificação no banco

- **Mensagens:** `SELECT id, conversa_id, direcao, texto, whatsapp_id, criado_em FROM mensagens ORDER BY id DESC LIMIT 20;`
  - Deve haver registros `out` (celular/sistema) e `in` (contato), com `whatsapp_id` quando o provedor envia.
- **Conversas:** `SELECT id, telefone, ultima_atividade FROM conversas ORDER BY ultima_atividade DESC LIMIT 10;`
  - `ultima_atividade` deve bater com a última mensagem da conversa.

### d) Duplicação e status

- Enviar a **mesma** mensagem do celular duas vezes (ou reenviar o webhook manualmente com o mesmo `messageId`).
- **Esperado:** não criar duas linhas para o mesmo `(conversa_id, whatsapp_id)`; índice único pode retornar 23505 e o código usa o registro existente; UI não duplica bolhas.
- Status (ticks): após envio, o webhook de status (POST `/webhooks/zapi/status`) deve atualizar `mensagens.status` e o front deve refletir ✓✓.

## Resumo de arquivos alterados (espelhamento + idempotência + debug)

| Arquivo | Motivo |
|--------|--------|
| `controllers/webhookZapiController.js` | `pickBestPhone`: para fromMe, prioriza `to`/`recipientPhone` e aceita JID quando não houver número BR; `extractMessage`: preserva phone raw (JID) para fromMe quando normalização BR retorna vazio; `getPayloads`: suporte a `body.messages` e `body.message`; `getFallbackPhoneForFromMe`: fallback de phone quando vazio em fromMe; após extração, fallback de phone e log `DROPPED` com WHATSAPP_DEBUG; log de diagnóstico por payload (eventType, messageId, from, to, chatId, fromMe); comentário de idempotência e cabeçalho atualizado. |
| `.env.example` | Comentário opcional para `WHATSAPP_DEBUG`. |
| `docs/TESTE-ESPELHAMENTO-WEBHOOK.md` | Este passo a passo. |

## Patch (trechos principais)

As mudanças estão aplicadas nos arquivos acima. Para revisão rápida:

1. **pickBestPhone**  
   - Ordem de candidatos para `fromMe`: `to`, `toPhone`, `recipientPhone`, … antes de `phone`.  
   - No final, se `fromMe` e nenhum candidato BR: aceitar primeiro item da lista se for JID (contém `@`) ou dígitos ≥ 10.

2. **extractMessage**  
   - `phone` final: usar `normalizePhoneBR(phone)`; se vazio e `fromMe` e phone raw contém `@`, usar o raw.

3. **Controller**  
   - Se `!phone && fromMe`: `phone = getFallbackPhoneForFromMe(payload)`.  
   - Se ainda `!phone`: log DROPPED (com WHATSAPP_DEBUG) e `continue`.  
   - Idempotência: ao encontrar mensagem existente por `(conversa_id, whatsapp_id)`, usar esse registro (atualizar conversa e emitir socket, sem novo insert).

4. **WHATSAPP_DEBUG**  
   - Log de cada payload (eventType, messageId, from, to, chatId, fromMe, hasText) e de DROPPED com motivo.
