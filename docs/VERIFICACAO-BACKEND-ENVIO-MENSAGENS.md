# Verificação Backend — Envio de Mensagens e Realtime

> Atualização 2026-03-28: este documento tem trechos legados de Meta/Z-API para referência histórica. O runtime atual usa UltraMsg (`/webhooks/ultramsg`) e não usa `webhookController`.

**Data:** 2025-03-06  
**Objetivo:** Garantir que o backend está correto para envio de mensagens, sem duplicação, com ticks em tempo real e nome/foto estáveis.

---

## ✅ 1. chatController — enviarMensagemChat

| Item | Status | Detalhes |
|------|--------|----------|
| Emissão única de `nova_mensagem` | ✅ | Emite **uma vez** após insert, antes do envio ao WhatsApp |
| Payload normalizado | ✅ | `novaMsgPayload` inclui `id`, `conversa_id`, `status`, `status_mensagem`, `whatsapp_id` |
| `status_mensagem` após envio | ✅ | Inclui `mensagem_id`, `conversa_id`, `status`, `whatsapp_id` |
| `status_mensagem` em erro | ✅ | Inclui `mensagem_id`, `conversa_id`, `status: 'erro'` |
| `conversa_atualizada` | ✅ | Inclui `nome_contato_cache`, `contato_nome`, `foto_perfil` quando disponíveis |

**Fluxo:**
1. INSERT mensagem (status: pending)
2. Emit `nova_mensagem` (payload normalizado)
3. Emit `conversa_atualizada` (com nome/foto)
4. Enviar ao provider (Z-API/Meta)
5. UPDATE status + whatsapp_id
6. Emit `status_mensagem` (sent/erro)

---

## ✅ 2. webhookZapiController — Anti-duplicação

| Item | Status | Detalhes |
|------|--------|----------|
| Idempotência por `whatsapp_id` | ✅ | Se mensagem já existe, não insere |
| Reconciliação fromMe | ✅ | Atualiza mensagem CRM (whatsapp_id null) com whatsapp_id do webhook |
| Match case-insensitive | ✅ | "Oi" vs "oi" reconcilia corretamente |
| `nova_mensagem` só quando INSERT | ✅ | `mensagemFoiInseridaPeloWebhook` — reconciliação emite apenas `status_mensagem` |
| `status_mensagem` reconciliação | ✅ | Inclui `mensagem_id`, `conversa_id`, `status`, `whatsapp_id` |

**Fluxo CRM → Z-API → Webhook:**
1. CRM insert + emit nova_mensagem
2. Z-API pode enviar webhook (ReceivedCallback fromMe)
3. Webhook: existente por whatsapp_id? Não (ainda não atualizou)
4. Webhook: reconcile — encontra mensagem out+null+texto
5. Webhook: UPDATE (não INSERT) → mensagemFoiInseridaPeloWebhook = false
6. Webhook: emite **apenas** status_mensagem (não nova_mensagem)

---

## ✅ 3. status_mensagem — Todos os pontos de emissão

| Origem | mensagem_id | conversa_id | status | whatsapp_id |
|--------|-------------|-------------|--------|-------------|
| chatController (sucesso) | ✅ | ✅ | ✅ | ✅ (quando disponível) |
| chatController (erro) | ✅ | ✅ | ✅ | — (não há) |
| webhookZapi (reconciliação) | ✅ | ✅ | ✅ | ✅ |
| webhookZapi (MessageStatusCallback) | ✅ | ✅ | ✅ | ✅ |
| webhookZapi (DeliveryCallback) | ✅ | ✅ | ✅ | ✅ |
| webhookController (Meta) | ✅ | ✅ | ✅ | ✅ |

---

## ✅ 4. emitirConversaAtualizada — Nome/foto estáveis

| Item | Status | Detalhes |
|------|--------|----------|
| Payload mínimo enriquecido | ✅ | Quando só `{ id }`, busca `nome_contato_cache`, `foto_perfil_contato_cache` |
| Evita sobrescrever com vazio | ✅ | Só inclui nome/foto quando existem no banco |

---

## ✅ 5. Rooms Socket

- `nova_mensagem`: `empresa_{company_id}`, `conversa_{conversa_id}`
- `status_mensagem`: `empresa_{company_id}`, `conversa_{conversa_id}`
- `conversa_atualizada`: `empresa_{company_id}`, `conversa_{conversa_id}`

---

## Conclusão

**O backend está correto.** Não há emissão duplicada de `nova_mensagem` para mensagens enviadas pelo CRM. O webhook reconcilia corretamente e emite apenas `status_mensagem` quando a mensagem já foi emitida pelo chatController.

Os bugs de duplicação e ticks observados no frontend são causados por:
1. **Frontend** adicionando a mensagem da resposta da API **e** do socket (append duplo)
2. **Frontend** não atualizando por `whatsapp_id` no `status_mensagem`

Ver `docs/CORRECOES-FRONTEND-BUGS-CRITICOS.md` para as correções necessárias no frontend.
