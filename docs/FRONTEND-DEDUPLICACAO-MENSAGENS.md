# Frontend: Deduplicação de Mensagens

## Regra obrigatória

**Ao receber `nova_mensagem` via socket:** fazer **upsert** (atualizar ou inserir) por `id`, nunca append cego.

```javascript
socket.on('nova_mensagem', (msg) => {
  const cid = msg.conversa_id
  const msgId = msg.id
  
  setMensagens(prev => {
    const idx = prev.findIndex(m => m.id === msgId || (m.whatsapp_id && m.whatsapp_id === msg.whatsapp_id))
    const nova = { ...msg, conversa_id: cid }
    
    if (idx >= 0) {
      // Atualizar existente — evita duplicata
      const next = [...prev]
      next[idx] = { ...next[idx], ...nova }
      return next
    }
    return [...prev, nova]
  })
})
```

## Evitar refetch em `atualizar_conversa`

Quando receber `atualizar_conversa` e a conversa for a aberta no chat: **NÃO** refetchar mensagens. A mensagem já chegou via `nova_mensagem`. Refetch pode causar duplicação ou flicker.

## Resposta da API (POST /chats/:id/mensagens)

Retorna `{ ok: true, id, conversa_id }` **sem** o objeto mensagem. **Não adicionar** nada da resposta. Aguardar `nova_mensagem` via socket.
