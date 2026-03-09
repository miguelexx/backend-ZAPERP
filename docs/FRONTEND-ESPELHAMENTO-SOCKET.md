# Frontend: tratamento de eventos para espelhamento correto

## Problema: "mensagem aparece e some"

Causa: ao receber `atualizar_conversa`, o frontend fazia refetch da lista ou das mensagens e **substituía** o estado. Em condições de rede ou timing, o refetch podia retornar dados desatualizados, fazendo a mensagem que acabou de chegar via `nova_mensagem` "desaparecer".

## Correção no backend

O backend **não emite mais** `atualizar_conversa` quando insere uma nova mensagem via webhook. Em vez disso:

1. **nova_mensagem** — contém a mensagem completa; adicionar na lista do chat aberto.
2. **conversa_atualizada** — contém `ultima_mensagem` (quando há insert) + `ultima_atividade`, `nome_contato_cache`, `foto_perfil_contato_cache`. Usar para atualizar o item na lista lateral **sem refetch**.

## Tratamento correto no frontend

### nova_mensagem
```javascript
socket.on('nova_mensagem', (msg) => {
  if (msg.conversa_id !== conversaAberta?.id) return
  // UPSERT por id ou (conversa_id, whatsapp_id) — evita duplicata
  setMensagens(prev => {
    const idx = prev.findIndex(m => m.id === msg.id || (m.whatsapp_id && m.whatsapp_id === msg.whatsapp_id))
    if (idx >= 0) return prev.map((m, i) => i === idx ? { ...m, ...msg } : m)
    return [...prev, msg]
  })
})
```

### conversa_atualizada
```javascript
socket.on('conversa_atualizada', (conv) => {
  // Atualizar item na lista lateral (merge defensivo — não sobrescrever com undefined)
  setConversas(prev => prev.map(c => c.id === conv.id ? { ...c, ...conv } : c))
  // Se trouxer ultima_mensagem, usar para preview na lista (sem refetch)
  if (conv.ultima_mensagem) {
    // Já está em conv; o merge acima atualiza o item
  }
})
```

### atualizar_conversa
**Importante:** O backend só emite quando NÃO é mensagem nova (ex.: status, transferência). Se o frontend usa para refetch:

- **Lista de conversas:** pode refetchar GET /chats; as mensagens já estão no banco.
- **Mensagens do chat aberto:** **NÃO** refetchar ao receber `atualizar_conversa` após `nova_mensagem`. A mensagem já foi adicionada via socket. Refetch pode causar "aparecer e sumir" se houver latência.

### Regra de ouro
**Nunca substituir** o array de mensagens do chat aberto por um refetch quando se acabou de receber `nova_mensagem` no mesmo segundo. Preferir sempre **upsert** (adicionar ou atualizar por id/whatsapp_id).
