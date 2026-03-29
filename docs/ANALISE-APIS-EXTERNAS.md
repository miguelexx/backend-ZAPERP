# Análise das APIs Externas — Implementação vs Documentação

**Data:** 2026-03-28  
**Escopo:** backend atual (UltraMsg, OpenAI, Supabase e legado Meta)

---

## 1) Integrações externas realmente ativas no backend

- **UltraMsg** (principal integração WhatsApp): envio, status, QR code, contatos, grupos e webhook.
- **OpenAI**: assistente do dashboard via `chat.completions.create`.
- **Supabase**: persistência e consultas administrativas server-side.

## 2) Integrações legadas

- **Meta WhatsApp Cloud API** aparece em `controllers/webhookController.js`, mas não está montada nas rotas ativas de `app.js`.
- O backend ativo usa `routes/webhookUltramsgRoutes.js` + `controllers/webhookUltramsgController.js`.

---

## 3) Matriz de conformidade por API

### 3.1 UltraMsg

**Documentação oficial:** [UltraMsg Docs](https://docs.ultramsg.com/)  
**Pontos verificados:** endpoints, payloads, autenticação por token, webhook settings.

| Item | Implementação atual | Conformidade |
|------|----------------------|--------------|
| Base URL | `https://api.ultramsg.com/{instance_id}` (`services/providers/ultramsg.js`) | ✅ |
| Envio mensagens (chat/media/location/etc.) | Endpoints e campos compatíveis | ✅ |
| Upload de mídia | `POST /media/upload` com multipart (`form-data`) | ✅ |
| Configuração de webhook | `POST /instance/settings` com campos oficiais | ✅ |
| Campo `webhook_message_reaction` | Campo não listado explicitamente na doc de `instance/settings` | ⚠️ opcional/compatibilidade |

Observação: a página oficial de `instance/settings` lista como obrigatórios `webhook_message_received`, `webhook_message_create`, `webhook_message_ack` e `webhook_message_download_media`. O campo de reaction pode existir por versão/changelog, então deve permanecer tolerante a falha.

### 3.2 OpenAI

**Documentação oficial:** [OpenAI Chat Create](https://platform.openai.com/docs/api-reference/chat/create)

| Item | Implementação atual | Conformidade |
|------|----------------------|--------------|
| SDK | `openai` v6 (`services/openaiClient.js`) | ✅ |
| Método | `client.chat.completions.create(...)` | ✅ |
| Timeout | 30s | ✅ |
| Retry automático | `maxRetries: 0` (fallback no controller) | ✅ |

### 3.3 Supabase

**Documentação oficial:** [Supabase API Keys](https://supabase.com/docs/guides/api/api-keys)

| Item | Implementação atual | Conformidade |
|------|----------------------|--------------|
| Cliente server-side | `@supabase/supabase-js` | ✅ |
| Chave de servidor | `SUPABASE_SERVICE_ROLE_KEY` | ✅ |
| Sessão persistente | `persistSession: false` | ✅ |

Observação de segurança: `service_role` é adequado no backend, mas por bypass de RLS exige disciplina estrita de filtros por `company_id` em todas as queries.

### 3.4 Meta WhatsApp Cloud API (legado)

**Documentação oficial:** [WhatsApp Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api/)

- O backend ativo não depende dessa integração no roteamento atual.
- Se for reativada no futuro, revisar versão da Graph API e validar assinatura webhook (`X-Hub-Signature-256`) de forma obrigatória.

---

## 4) Divergências reais encontradas

1. **Risco de drift documental**: há documentos antigos mencionando fluxo Meta como ativo, mas o runtime atual usa UltraMsg.
2. **Campo de webhook reaction na UltraMsg**: pode não ser universal na rota de settings; tratar como opcional (não bloquear configuração se rejeitado).

---

## 5) Ações aplicadas nesta refatoração

- Correção de robustez no parsing de JSON do QR Code em `services/ultramsgIntegrationService.js`.
- Endurecimento de segurança no middleware de webhook:
  - fallback por `instanceId` agora é controlado por `ALLOW_INSTANCEID_WEBHOOK_FALLBACK`;
  - padrão: desativado em produção, ativado apenas fora de produção.

---

## 6) Referências oficiais consultadas

- [UltraMsg instance settings](https://docs.ultramsg.com/api/post/instance/settings)
- [OpenAI chat completions](https://platform.openai.com/docs/api-reference/chat/create)
- [Supabase API keys](https://supabase.com/docs/guides/api/api-keys)
- [Meta WhatsApp Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api/)
