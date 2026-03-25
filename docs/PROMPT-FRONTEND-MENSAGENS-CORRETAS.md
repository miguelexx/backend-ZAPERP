# Prompt para o Frontend — Verificação e Correção do Fluxo de Mensagens

Use este prompt para auditar e corrigir o fluxo de mensagens sem quebrar o que já funciona.

---

## OBJETIVO

Garantir que as mensagens:
1. **Apareçam imediatamente** após envio (sem delay visual)
2. **Fiquem em ordem cronológica correta** (mais antiga em cima, mais recente embaixo)
3. **Nunca sejam ocultadas ou duplicadas**
4. **Atualizem o status** (✓ enviado, ✓✓ entregue/lido) sem sumir ou reaparecer

> ⚠️ **NÃO alterar nada que já funciona corretamente.** Este prompt é uma auditoria: verificar, e só corrigir onde estiver errado.

---

## Contrato do Backend (não muda)

### Ao enviar uma mensagem (POST /chats/:id/mensagens)

A API retorna **apenas**:
```json
{ "ok": true, "id": 123, "conversa_id": 456, "status": "sent" }
```

**Não tem o objeto mensagem completo.** A mensagem completa chega pelo socket `nova_mensagem`.

### Eventos de socket relevantes

| Evento | O que significa | O que o frontend deve fazer |
|---|---|---|
| `nova_mensagem` | Nova mensagem (enviada ou recebida) | Fazer **upsert** na lista de mensagens do chat aberto |
| `status_mensagem` | Status atualizado (sent, entregue, lido, erro) | Atualizar apenas o status da mensagem pelo `mensagem_id` |
| `mensagem_editada` | Texto editado via WhatsApp | Atualizar apenas o texto da mensagem pelo `id` |
| `conversa_atualizada` | Preview da lista lateral atualizado | Merge defensivo na lista — **NUNCA** adicionar às mensagens |
| `atualizar_conversa` | Sinaliza que conversa mudou | Refetch opcional da lista — **NUNCA** refetch das mensagens do chat aberto |

---

## Regras críticas (verificar uma a uma)

### 1. Upsert em `nova_mensagem` — nunca append cego

```javascript
function upsertMensagem(prev, nova) {
  // Tenta match por id
  const idxById = prev.findIndex(m => m.id === nova.id)
  if (idxById >= 0) return prev.map((m, i) => i === idxById ? { ...m, ...nova } : m)

  // Tenta match por whatsapp_id + conversa_id (para mensagens espelhadas)
  const waId = nova.whatsapp_id || null
  if (waId && nova.conversa_id) {
    const idxByWa = prev.findIndex(
      m => m.conversa_id === nova.conversa_id && String(m.whatsapp_id || '') === String(waId)
    )
    if (idxByWa >= 0) return prev.map((m, i) => i === idxByWa ? { ...m, ...nova, id: nova.id } : m)
  }

  // Mensagem realmente nova: adicionar ao final
  return [...prev, nova]
}

socket.on('nova_mensagem', (msg) => {
  if (msg.conversa_id === conversaAbertaId) {
    setMensagens(prev => upsertMensagem(prev, msg))
    // rolar para o fim apenas se o usuário já estava no fim
  }
})
```

**Verificar:**
- [ ] O handler de `nova_mensagem` usa upsert (não push/append simples)
- [ ] Não há segundo handler do mesmo evento em outro lugar do código
- [ ] O evento é registrado uma única vez (sem re-registro em re-renders)

---

### 2. Não adicionar mensagem da resposta da API

```javascript
// ✅ CORRETO
const res = await api.post(`/chats/${conversaId}/mensagens`, { texto })
// res = { ok, id, conversa_id, status } — não tem objeto mensagem
// A mensagem virá pelo socket nova_mensagem — não adicionar aqui

// ❌ ERRADO
const res = await api.post(...)
setMensagens(prev => [...prev, res.data.mensagem]) // duplica com o socket
```

**Verificar:**
- [ ] Após o POST de envio, o frontend **não adiciona** nada à lista de mensagens
- [ ] Não há optimistic update que insere e depois não remove duplicata ao chegar o socket

---

### 3. Não refetchar mensagens ao receber `atualizar_conversa`

```javascript
// ✅ CORRETO
socket.on('atualizar_conversa', ({ id }) => {
  // Só atualiza a lista de conversas (sidebar), nunca as mensagens abertas
  refetchListaConversas() // opcional
})

// ❌ ERRADO
socket.on('atualizar_conversa', ({ id }) => {
  if (id === conversaAbertaId) {
    buscarMensagens(id) // substitui o estado, apaga mensagens recém-chegadas
  }
})
```

**Verificar:**
- [ ] `atualizar_conversa` **não dispara** GET /chats/:id no chat aberto
- [ ] `conversa_atualizada` **não dispara** GET /chats/:id no chat aberto

---

### 4. Ordenação cronológica garantida

O backend retorna mensagens da API em ordem crescente (`criado_em ASC`). Mensagens de socket chegam em tempo real e devem ser adicionadas ao final.

**Verificar:**
- [ ] A lista de mensagens **não é re-ordenada** no frontend (o backend já entrega na ordem certa)
- [ ] Ao adicionar via `nova_mensagem`, a mensagem vai ao **final** do array
- [ ] Não há `sort()` por `criado_em` no frontend que possa causar reordenação indesejada

---

### 5. Status atualizado sem remover a mensagem

```javascript
socket.on('status_mensagem', ({ mensagem_id, conversa_id, status, status_mensagem, whatsapp_id }) => {
  setMensagens(prev => prev.map(m => {
    const matchById = m.id === mensagem_id
    const matchByWa = whatsapp_id && m.conversa_id === conversa_id
      && String(m.whatsapp_id || '') === String(whatsapp_id)
    if (!matchById && !matchByWa) return m
    return { ...m, status: status ?? m.status, status_mensagem: status_mensagem ?? m.status_mensagem, whatsapp_id: whatsapp_id ?? m.whatsapp_id }
  }))
})
```

**Verificar:**
- [ ] `status_mensagem` faz `map` (não filtra ou remove)
- [ ] Match por `mensagem_id` **ou** por `whatsapp_id` + `conversa_id`

---

### 6. Sem memory leak de handlers de socket

**Verificar:**
- [ ] Handlers de socket são removidos no cleanup (`socket.off` ou `useEffect` cleanup)
- [ ] O socket não está sendo reconectado/reiniciado desnecessariamente ao mudar de conversa

---

## Checklist final de aceite

- [ ] Enviar mensagem: aparece **imediatamente** (< 200ms após pressionar enviar)
- [ ] Receber mensagem: aparece **imediatamente** ao chegar
- [ ] Ordem: sempre cronológica (mais antiga em cima, mais recente embaixo)
- [ ] Sem duplicatas ao enviar
- [ ] Sem mensagem "piscando" ou desaparecendo
- [ ] Ticks ✓ ✓✓ atualizam sem mover a mensagem na lista
- [ ] Ao abrir conversa: histórico carrega em ordem correta
- [ ] Ao receber `atualizar_conversa`: mensagens do chat aberto **não somem**
