# Integração UltraMsg: Foto de Perfil

**Data:** 12/03/2025  
**Objetivo:** Buscar foto de perfil corretamente via GET /contacts/image ao receber mensagem.

---

## 1. Diagnóstico

### Problema
- O webhook UltraMsg (`message_received`, `message_ack`) **não traz** profile picture no payload.
- Não devemos tentar obter foto pelo webhook — campos como `data.photo`, `data.senderPhoto` não existem ou são nulos.
- Foto deve ser obtida via API oficial: `GET /{instance_id}/contacts/image?token=...&chatId=...`

### Solução implementada
1. **Webhook:** Usar `data.from` como chatId do contato (formato `5511999999999@c.us`).
2. **Sync:** Disparar `syncUltraMsgContact(chatId, companyId)` quando mensagem é recebida.
3. **API:** Chamar `GET /contacts/image` com chatId (não phone) para garantir formato exato.
4. **Banco:** Preencher `conversas.foto_perfil_contato_cache` e `clientes.foto_perfil` apenas quando foto válida retornar.
5. **Nome:** Manter pushname do webhook como nome inicial; não sobrescrever com dado pior.

---

## 2. Arquivos alterados

| Arquivo | Alteração |
|---------|-----------|
| `controllers/webhookUltramsgController.js` | `senderPhoto = null` — não usar webhook para foto |
| `controllers/webhookZapiController.js` | Passar `payload.chatId` (data.from) para `syncUltraMsgContact` |
| `services/ultramsgSyncContact.js` | Usar chatId em `getProfilePicture`; passar `opts.chatId` |
| `services/providers/ultramsg.js` | `getProfilePicture` aceita `opts.chatId` para uso direto |

---

## 3. Regras obrigatórias cumpridas

- [x] Não tentar obter foto pelo webhook (payload não traz profile picture).
- [x] Usar `data.from` como chatId ao chegar mensagem recebida.
- [x] Consultar `GET /{instance_id}/contacts/image` com parâmetros `token` e `chatId`.
- [x] Preencher `conversas.foto_perfil_contato_cache`.
- [x] Preencher `clientes.foto_perfil` quando aplicável.
- [x] Manter pushname do webhook como nome inicial.
- [x] Não quebrar fluxo atual.
- [x] Não chamar `contacts/image` em toda listagem (usa cache/banco).
- [x] Nunca expor token em logs (sempre `maskToken`).

---

## 4. Checklist de teste

### Pré-requisitos
- [ ] Instância UltraMsg conectada (status `authenticated`).
- [ ] Webhook configurado em `Instance Settings → Webhook URL`.
- [ ] `company_id` mapeado para `instance_id` na tabela `empresa_zapi`.

### Teste 1: Mensagem recebida (individual)
1. [ ] Enviar mensagem do celular do contato para o número da instância.
2. [ ] Verificar log: `[Z-API_WEBHOOK]` com `fromMe: false`.
3. [ ] Confirmar que mensagem aparece no painel.
4. [ ] Conferir se `conversas.foto_perfil_contato_cache` foi preenchida (se o contato tiver foto).
5. [ ] Conferir se `clientes.foto_perfil` foi preenchida quando há cliente vinculado.
6. [ ] Verificar que `nome_contato_cache` tem pushname ou nome da API.
7. [ ] Verificar que foto aparece no cabeçalho/cache da conversa.

### Teste 2: Grupos ignorados
1. [ ] Enviar mensagem em grupo.
2. [ ] Confirmar que `syncUltraMsgContact` **não** é chamada para grupos (sem GET /contacts/image).
3. [ ] Mensagem deve ser processada normalmente.

### Teste 3: Listagem sem API
1. [ ] Abrir lista de conversas no painel.
2. [ ] Verificar que não há chamadas a `GET /contacts/image` durante a listagem.
3. [ ] Fotos exibidas vêm de `foto_perfil_contato_cache` ou `clientes.foto_perfil`.

### Teste 4: Token não exposto
1. [ ] Ativar log detalhado (se disponível).
2. [ ] Buscar por `token` em logs — não deve aparecer valor completo.
3. [ ] Apenas `maskToken` (ex.: `55***99`) pode aparecer.

### Teste 5: Mensagem enviada (fromMe)
1. [ ] Enviar mensagem pela plataforma para um contato.
2. [ ] Confirmar que sync é chamada com `skipCache: true` para buscar foto do destinatário.
3. [ ] Cache deve ser atualizado com foto se disponível.

---

## 5. Fluxo resumido

```
Webhook message_received (UltraMsg)
  → normalizeUltramsgToZapi (senderPhoto=null, chatId=data.from)
  → receberZapi (webhookZapiController)
  → syncUltraMsgContact(payload.chatId || phone, company_id)
    → getProfilePicture(chatId, { companyId, chatId })
      → GET /{instance_id}/contacts/image?token=...&chatId=5511999999999@c.us
    → Atualiza conversas.foto_perfil_contato_cache (se foto válida)
    → getOrCreateCliente(...) → clientes.foto_perfil (se foto válida)
  → Mensagem gravada + pushname salvo
  → Socket: nova_mensagem, conversa_atualizada
```
