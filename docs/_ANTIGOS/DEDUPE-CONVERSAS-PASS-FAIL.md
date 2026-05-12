# Deduplicação Conversas/Contatos — Relatório PASS/FAIL

Objetivo: garantir **1 conversa por contato por empresa**, igual WhatsApp Web, independente de onde a mensagem foi enviada (CRM ou celular).

---

## Alterações Implementadas

### A) Chave canônica (resolvePeerPhone)

- **`resolvePeerPhone(payload)`** em `helpers/conversationKeyHelper.js`
  - `fromMe=false`: peerPhone = payload.phone (normal)
  - `fromMe=true`:
    - **Prioridade**: to, toPhone, recipientPhone, key.remoteJid, etc.
    - **Fallback 1**: payload.phone existe e ≠ connectedPhone → usar payload.phone
    - **Fallback 2**: só chatLid (@lid) → retorna null, keyType='lid' (NUNCA criar "Novo contato" com connectedPhone)
  - **REGRA**: NUNCA retornar connectedPhone como peerPhone
  - Log DEV: `WHATSAPP_DEBUG=true` → `{ fromMe, connectedPhone, phone, to, peerPhone, source }`

### B) Mesclagem LID→PHONE em todos os callbacks

- **`mergeConversationLidToPhone(company_id, chatLid, canonicalPhone)`** em `helpers/conversationSync.js`
  - Localiza conversa LID e conversa PHONE; mescla LID na PHONE; emite `conversa_atualizada`
  - Chamada em: **ReceivedCallback**, **DeliveryCallback**, **MessageStatusCallback**

### C) Upsert cliente/conversa

- Cliente: busca por `possiblePhonesBR`, atualiza só campos não-nulos (nome, foto)
- Conversa: prioriza busca por `chat_lid` quando há LID no payload; mescla LID→PHONE quando ambos existem
- Índice UNIQUE: `clientes(company_id, telefone)`

### D) Enriquecimento (nome/foto) sem sobrescrever

- Prioridade nome: senderName > chatName > pushname > nome atual
- Prioridade foto: payload.photo > senderPhoto > foto atual
- **NUNCA** sobrescrever com null ou ""

### E) Deduplicação de duplicados existentes

- **POST /chats/merge-duplicatas** (admin): mescla por phoneKeyBR + reconcilia LID→PHONE
- **Script**: `node scripts/certificacao/deduplicate-conversations.js [company_id]`

### F) Frontend

- De-dup de mensagens por `whatsapp_id` no state
- Lista de conversas: preferir conversa com telefone (canonicalPhone); remover LID após merge
- Ao receber `conversa_atualizada`: atualizar nome/foto imediatamente na lista

---

## Checklist de Prova (preencher após testes)

| # | Teste | PASS | FAIL | Evidência |
|---|-------|------|------|-----------|
| 1 | Abrir conversa existente de um contato | ⬜ | ⬜ | conversa_id, telefone |
| 2 | Enviar mensagem pelo CELULAR (fromMe) → cai na MESMA conversa | ⬜ | ⬜ | log peerPhone, conversa_id |
| 3 | Não cria "Sem conversa" ou conversa duplicada | ⬜ | ⬜ | SQL A retorna 0 |
| 4 | Enviar mensagem pelo CRM → cai na mesma conversa | ⬜ | ⬜ | conversa_id único |
| 5 | Nome/foto/telefone permanecem corretos | ⬜ | ⬜ | SQL C, print |
| 6 | Auditoria retorna 0 duplicados | ⬜ | ⬜ | SQL A e B |

---

## SQLs de Prova (rodar e anexar resultado)

```bash
psql $DATABASE_URL -f scripts/certificacao/prova-sql.sql
```

| SQL | Resultado esperado |
|-----|-------------------|
| **A** Duplicados conversas por telefone | 0 linhas |
| **B** Mensagens duplicadas por whatsapp_id | 0 linhas |
| **C** Contatos sem nome/foto | Auditoria (pode haver) |

---

## Comandos úteis

```bash
# Prova (A, B, C)
psql $DATABASE_URL -f scripts/certificacao/prova-sql.sql

# Auditoria completa
psql $DATABASE_URL -f scripts/certificacao/auditoria-duplicados.sql

# Dedupe (via API, requer auth admin)
curl -X POST /chats/merge-duplicatas -H "Authorization: Bearer TOKEN"

# Dedupe (script standalone)
node scripts/certificacao/deduplicate-conversations.js 1
```
