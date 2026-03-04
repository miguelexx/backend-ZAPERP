# Certificação WhatsApp Web-like (Z-API) — Relatório

Este documento descreve os ajustes realizados e o checklist de certificação para validar que o sistema se comporta como WhatsApp Web em tempo real.

---

## 1. Ajustes Realizados no Backend

### 1.1 Socket/WebSocket (Tempo Real)

| Evento | Payload | Rooms | Quando |
|--------|---------|-------|--------|
| `nova_mensagem` | `{ conversa_id, mensagem, whatsapp_id, status, ... }` | `empresa_*`, `conversa_*`, `departamento_*` | ReceivedCallback, fromMe espelhado |
| `status_mensagem` | `{ mensagem_id, conversa_id, status, whatsapp_id }` | `empresa_*`, `conversa_*` | DeliveryCallback, MessageStatusCallback |
| `conversa_atualizada` | `{ id, ultima_atividade, nome_contato_cache, foto_perfil_contato_cache }` | `empresa_*`, `departamento_*` | Nova mensagem, LID reconciliation |
| `atualizar_conversa` | `{ id }` | `empresa_*`, `departamento_*` | Indica que a lista deve atualizar |

**Mudanças aplicadas:**
- `status_mensagem` agora inclui `whatsapp_id` para o frontend fazer de-dup e atualizar ticks por `whatsapp_id`.
- `conversa_atualizada` enriquecida com `ultima_atividade`, `nome_contato_cache` e `foto_perfil_contato_cache` (quando preenchidos).

### 1.2 Idempotência e Anti-duplicação

| Área | Implementação |
|------|---------------|
| **Mensagens** | Unique por `(company_id, whatsapp_id)`. Idempotência usa `company_id` (não `conversa_id`) para buscar existente. |
| **Clientes** | Unique por `(company_id, telefone)`. |
| **Conversas** | Unique por `(company_id, telefone)` para abertas. LID→telefone: `mergeConversationLidToPhone` em ReceivedCallback, DeliveryCallback, MessageStatusCallback. |
| **fromMe** | `resolvePeerPhone` (centralizado) prioriza `to`, `toPhone`, `recipientPhone`, `key.remoteJid` para identificar conversa do DESTINO (contato que recebeu), nunca `connectedPhone`. |

### 1.4 Chave canônica (helpers/conversationKeyHelper.js)

- **resolvePeerPhone(payload)**: Extrai o número do CONTATO (peer). Para `fromMe=true`: prioridade to/toPhone/recipientPhone; fallback payload.phone (se ≠ connectedPhone); se só LID retorna null (nunca connectedPhone).
- **resolveConversationKey(payload, company_id)**: Retorna `{ canonicalPhone, chatLid, keyType }`. Centraliza a lógica para evitar duplicação.
- **mergeConversationLidToPhone**: Helper chamado em todos os callbacks que trazem chatLid + canonicalPhone; mescla conversa LID na PHONE e emite `conversa_atualizada`.
- Log DEV (`WHATSAPP_DEBUG=true`): `{ fromMe, connectedPhone, phone, to, peerPhone, source }`.

### 1.3 Nome, Foto e Pushname (Igual WhatsApp Web)

| Prioridade | Campo | Origem |
|------------|-------|--------|
| 1 | senderName | Payload Z-API |
| 2 | chatName | Payload (quando fromMe) |
| 3 | pushname | Payload |
| 4 | nome existente | Banco |

- **Cache na conversa**: `nome_contato_cache` e `foto_perfil_contato_cache` atualizados para **todos** os contatos individuais (não só LID) quando `senderName` ou `senderPhoto` vêm no payload.
- **Regra**: nunca sobrescrever com `null` — apenas atualizar quando vier valor.

---

## 2. Checklist de Certificação (PASS/FAIL)

### A) Receber do celular

| # | Teste | PASS | FAIL | Evidência |
|---|-------|------|------|-----------|
| A1 | Enviar "oi" do celular para o número conectado | ⬜ | ⬜ | log backend: type, messageId, fromMe, peerPhone |
| A2 | Webhook ReceivedCallback chegou | ⬜ | ⬜ | log: instanceId, companyId, eventType |
| A3 | Inseriu em `mensagens` com `whatsapp_id` | ⬜ | ⬜ | `SELECT id, conversa_id, whatsapp_id FROM mensagens WHERE whatsapp_id=?` |
| A4 | Atualizou conversa/cliente com nome/foto | ⬜ | ⬜ | `SELECT nome_contato_cache, foto_perfil_contato_cache FROM conversas WHERE id=?` |
| A5 | Evento `nova_mensagem` emitido e front atualizou | ⬜ | ⬜ | socket: `nova_mensagem` + conversa_id + whatsapp_id |

### B) Enviar do CRM

| # | Teste | PASS | FAIL | Evidência |
|---|-------|------|------|-----------|
| B1 | Enviar mensagem no CRM | ⬜ | ⬜ | - |
| B2 | Salva imediatamente com status `pending` ou `sent` | ⬜ | ⬜ | mensagens.status |
| B3 | DeliveryCallback/Status atualiza para `delivered`/`read` | ⬜ | ⬜ | mensagens.status, log |
| B4 | Ticks atualizam no front (`status_mensagem`) | ⬜ | ⬜ | socket: status_mensagem + whatsapp_id |

### C) Espelhamento (fromMe)

| # | Teste | PASS | FAIL | Evidência |
|---|-------|------|------|-----------|
| C1 | Enviar mensagem pelo próprio celular (fromMe=true) | ⬜ | ⬜ | log: peerPhone = destino |
| C2 | Mensagem cai na conversa do contato correto | ⬜ | ⬜ | conversa_id único por telefone |
| C3 | Exibida como OUT (direção saída) | ⬜ | ⬜ | mensagens.direcao='out' |
| C4 | Não cria conversa duplicada do "meu número" | ⬜ | ⬜ | SQL A: 0 duplicados |

### D) Anti-duplicação

| # | Teste | PASS | FAIL | Evidência |
|---|-------|------|------|-----------|
| D1 | Repetir webhook com mesmo `messageId` → não duplica mensagem | ⬜ | ⬜ | SQL B: 0 duplicados |
| D2 | Não existem duas conversas para o mesmo `canonicalPhone` | ⬜ | ⬜ | SQL A: 0 linhas |

### E) Dados do contato

| # | Teste | PASS | FAIL | Evidência |
|---|-------|------|------|-----------|
| E1 | Para 10 contatos: UI exibe nome, telefone formatado, foto | ⬜ | ⬜ | print |
| E2 | No banco: `clientes.foto_perfil` preenchido quando disponível | ⬜ | ⬜ | SQL C |
| E3 | No banco: `conversas.foto_perfil_contato_cache` quando LID ou sem cliente | ⬜ | ⬜ | SQL |

### F) Multi-tenant

| # | Teste | PASS | FAIL | Evidência |
|---|-------|------|------|-----------|
| F1 | Company A: webhook com `instanceId` A → impacta só company A | ⬜ | ⬜ | companyId no log |
| F2 | Company B: webhook com `instanceId` B → impacta só company B | ⬜ | ⬜ | companyId no log |
| F3 | Sem vazamento entre empresas | ⬜ | ⬜ | mensagens/conversas filtradas |

---

## 3. Scripts e Ferramentas

### SQL de Auditoria

- `scripts/certificacao/prova-sql.sql` — SQLs de prova A, B, C (duplicados conversas/mensagens, contatos sem foto)
- `scripts/certificacao/auditoria-duplicados.sql` — duplicados em clientes, conversas e mensagens
- `scripts/certificacao/auditoria-contatos-sem-foto.sql` — contatos sem nome ou foto

### Deduplicação

- **POST /chats/merge-duplicatas** (auth, admin) — mescla conversas duplicadas por telefone + reconcilia LID
- `scripts/certificacao/deduplicate-conversations.js [company_id]` — script standalone (Supabase direto)

### Curl de Teste

- `scripts/certificacao/test-webhooks-curl.sh` — simula ReceivedCallback, DeliveryCallback, MessageStatusCallback (fromMe com `to` = destino)

### Instrumentação [ZAPI_CERT]

- `WHATSAPP_DEBUG=true` (apenas dev) — loga uma linha `[ZAPI_CERT]` por webhook com: ts, companyId, instanceId, type, fromMe, hasDest, phoneTail, connectedTail, messageId, resolvedKeyType, conversaId, action

---

## 4. Frontend — Orientações

### Escuta de eventos

```javascript
// nova_mensagem: inserir na lista sem recarregar; append + scroll se conversa aberta
socket.on('nova_mensagem', (msg) => {
  // De-dup por whatsapp_id
  if (msg.whatsapp_id && lista.some(m => m.whatsapp_id === msg.whatsapp_id)) return
  // ...
})

// status_mensagem: atualizar ticks por whatsapp_id ou mensagem_id
socket.on('status_mensagem', ({ mensagem_id, conversa_id, status, whatsapp_id }) => {
  // Atualizar balão correspondente
})

// conversa_atualizada: atualizar lista lateral (nome, foto, ultima_atividade)
socket.on('conversa_atualizada', (conv) => {
  // Atualizar item na lista imediatamente (nome_contato_cache, foto_perfil_contato_cache)
  setConversas(prev => prev.map(c => c.id === conv.id ? { ...c, ...conv } : c))
})

// Dedupe na lista: usar conversa.id como key, dedupar por telefone/canonicalPhone
// Preferir conversa com telefone real; ao receber conversa_atualizada após merge LID→PHONE,
// remover duplicada (LID) do state e manter a PHONE atualizada
```

---

## 5. Resumo Pass/Fail (preencher após testes)

| Bloco | Status |
|-------|--------|
| A) Receber do celular | ⬜ |
| B) Enviar do CRM | ⬜ |
| C) Espelhamento | ⬜ |
| D) Anti-duplicação | ⬜ |
| E) Dados do contato | ⬜ |
| F) Multi-tenant | ⬜ |
