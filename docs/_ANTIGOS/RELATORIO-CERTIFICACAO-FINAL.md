# Relatório Final — Certificação WhatsApp Web-like (Z-API)

**Objetivo:** Certificar que TUDO está funcionando igual WhatsApp Web para `company_id=1` e `company_id=2`, sem regredir Company 1.

**Instrumentação:** `WHATSAPP_DEBUG=true` (apenas dev) → log `[ZAPI_CERT]` uma linha por webhook processado.

---

## 1) Instrumentação (Log Dev Controlado)

Formato do log `[ZAPI_CERT]`:
```
[ZAPI_CERT] { ts, companyId, instanceId, type, fromMe, hasDest, phoneTail, connectedTail, messageId, resolvedKeyType, conversaId, action }
```

**Actions:**
| action | Significado |
|--------|-------------|
| `inserted_message` | Mensagem inserida em `mensagens` |
| `updated_status` | Status de mensagem atualizado (ticks) |
| `merged_lid_phone` | Conversa LID mesclada em PHONE |
| `self_echo_status_update` | Self-echo fromMe: atualizou status por `whatsapp_id` |
| `self_echo_ignored_no_match` | Self-echo fromMe: ignorado (200) sem match |
| `dropped_invalid_payload` | Payload inválido (phone não resolvido) — raríssimo |

**Como ativar:** `WHATSAPP_DEBUG=true` no `.env` antes de iniciar o servidor.

---

## 2) Testes Reais — PASS/FAIL com Evidência

### A) Company 1 — Receber

| # | Teste | PASS | FAIL | Evidência |
|---|-------|:----:|:----:|-----------|
| A1 | Enviar msg celular externo → company 1 (fromMe=false) | | | |
| | Inserir em `mensagens` com `company_id=1` e `whatsapp_id=messageId` | | | Log [ZAPI_CERT] `action: inserted_message`, SQL |
| | Emitir socket `nova_mensagem` para `empresa_1` | | | DevTools / log frontend |
| | Front company 1 atualiza em tempo real | | | Visual |

**Evidência Log (exemplo):**
```
[ZAPI_CERT] {"ts":"...","companyId":1,"instanceId":"...","type":"ReceivedCallback","fromMe":false,"hasDest":true,"phoneTail":"999999","connectedTail":"888888","messageId":"...","resolvedKeyType":"from payload.phone","conversaId":123,"action":"inserted_message"}
```

**Evidência SQL:**
```sql
SELECT id, conversa_id, company_id, whatsapp_id, direcao, texto 
FROM mensagens 
WHERE company_id = 1 
ORDER BY id DESC LIMIT 5;
```

---

### B) Company 2 — Receber

| # | Teste | PASS | FAIL | Evidência |
|---|-------|:----:|:----:|-----------|
| B1 | Enviar msg celular externo → company 2 (fromMe=false) | | | |
| | Inserir em `mensagens` com `company_id=2` e `whatsapp_id=messageId` | | | Log [ZAPI_CERT], SQL |
| | Emitir socket `nova_mensagem` para `empresa_2` | | | DevTools |
| | Front company 2 atualiza em tempo real | | | Visual |

---

### C) Envio pelo CRM + Ticks/Status

| # | Teste | PASS | FAIL | Evidência |
|---|-------|:----:|:----:|-----------|
| C1 | Enviar pelo CRM (company 2 e company 1) | | | |
| | Salvar imediatamente com `whatsapp_id` retornado pela Z-API | | | SQL mensagens |
| | DeliveryCallback/MessageStatusCallback atualiza status (sent/delivered/read) | | | Log [ZAPI_CERT] `action: updated_status` |
| | Emitir socket `status_mensagem` { whatsapp_id, status } | | | DevTools |
| | Front atualiza ticks sem refresh | | | Visual |

---

### D) Espelhamento fromMe

| # | Teste | PASS | FAIL | Evidência |
|---|-------|:----:|:----:|-----------|
| D1 | Enviar msg pelo celular (mesma instância) para contato real | | | |
| | Se payload tem destino (to/remoteJid): cai na conversa correta como OUT | | | Log `inserted_message`, conversa_id correto |
| | Se self-echo (phone==connectedPhone e sem destino): não cria conversa | | | Log `self_echo_status_update` ou `self_echo_ignored_no_match` |
| | Responde 200 sem DROPPED de erro | | | Curl / Postman |

**Teste self-echo via curl:**
```bash
# Payload: fromMe=true, phone=connectedPhone, SEM to/recipient
# Esperado: action=self_echo_status_update ou self_echo_ignored_no_match
```

---

### E) Anti-duplicação (DB)

Executar `scripts/certificacao/antiduplicacao-verificacao.sql`:

| # | Query | Esperado | Evidência |
|---|-------|----------|-----------|
| E1 | Conversas duplicadas por `(company_id, telefone)` | 0 linhas | Copiar resultado SQL |
| E2 | Clientes duplicados por `(company_id, telefone)` | 0 linhas | Copiar resultado SQL |
| E3 | Mensagens duplicadas por `(company_id, whatsapp_id)` | 0 linhas | Copiar resultado SQL |

---

### F) Enriquecimento (nome/foto)

| # | Teste | PASS | FAIL | Evidência |
|---|-------|:----:|:----:|-----------|
| F1 | Em 5 msgs recebidas (company 2): | | | |
| | `clientes.nome` / `foto_perfil` preenchidos quando payload tiver senderName/photo | | | SQL |
| | `conversas.nome_contato_cache` / `foto_perfil_contato_cache` preenchidos | | | SQL |
| | Nunca sobrescrever por null | | | Revisar código |

**SQL de verificação:**
```sql
SELECT c.id, c.nome, c.foto_perfil, conv.nome_contato_cache, conv.foto_perfil_contato_cache
FROM clientes c
JOIN conversas conv ON conv.cliente_id = c.id
WHERE c.company_id = 2
ORDER BY conv.ultima_atividade DESC
LIMIT 5;
```

---

## 3) Socket (Tempo Real)

| Evento | Comportamento | Verificação |
|--------|---------------|-------------|
| `nova_mensagem` | Chega no frontend sem reload | Abrir conversa, receber msg de outro dispositivo → aparece na bolha |
| `status_mensagem` | Atualiza ticks por `whatsapp_id` | Enviar msg → ver ticks ✓ → ✓✓ → azul |
| `conversa_atualizada` | Atualiza lista lateral (nome/foto/ultima_atividade) | Nome/foto aparecem sem refresh |

**Frontend — Dedupe por `whatsapp_id`:**
Se ainda não existir, adicionar no handler de `nova_mensagem`:
```javascript
if (msg.whatsapp_id && mensagens.some(m => m.whatsapp_id === msg.whatsapp_id)) return
```

---

## 4) Entrega Final

- [ ] Relatório preenchido com PASS/FAIL para cada item A-F
- [ ] 1 trecho de log `[ZAPI_CERT]` por item (quando aplicável)
- [ ] 1 query SQL por item (quando aplicável)
- [ ] Confirmação: **Company 1 não regrediu**
- [ ] Se algum item falhar: correção mínima aplicada e teste repetido

---

## 5) Scripts Úteis

| Script | Uso |
|-------|-----|
| `scripts/certificacao/test-webhooks-curl.sh BASE_URL INSTANCE_ID` | Simula ReceivedCallback, fromMe, status |
| `scripts/certificacao/antiduplicacao-verificacao.sql` | Queries E1, E2, E3 |
| `scripts/simular-msg-celular.js` | Simula mensagem enviada pelo celular (fromMe) |

---

## 6) Confirmação Company 1

Após todos os testes, verificar:

- [ ] Receber mensagem para company 1 → insere e emite socket
- [ ] Enviar pelo CRM company 1 → salva whatsapp_id, ticks atualizam
- [ ] Self-echo não quebra nada
- [ ] Sem duplicados (E1, E2, E3)
