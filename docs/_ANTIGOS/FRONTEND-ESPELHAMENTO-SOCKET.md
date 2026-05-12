# Frontend: tratamento de eventos para espelhamento correto

## Problema: "mensagem aparece e some"

Causa: ao receber `atualizar_conversa`, o frontend fazia refetch da lista ou das mensagens e **substituía** o estado. Em condições de rede ou timing, o refetch podia retornar dados desatualizados, fazendo a mensagem que acabou de chegar via `nova_mensagem` "desaparecer".

## Correção no backend

O backend **não emite mais** `atualizar_conversa` quando insere uma nova mensagem via webhook. Em vez disso:

1. **nova_mensagem** — contém a mensagem completa; adicionar na lista do chat aberto.
2. **conversa_atualizada** — contém `ultima_mensagem_preview` (quando há insert: `texto`, `criado_em`, `direcao` — **sem id**) + `ultima_atividade`, `nome_contato_cache`, `foto_perfil_contato_cache`. Usar **apenas para preview** na lista lateral; **nunca** adicionar ao array de mensagens (evita duplicata/bolha).

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
  // Merge defensivo: só sobrescrever campos definidos (evita nome/foto sumirem)
  setConversas(prev => prev.map(c => {
    if (c.id !== conv.id) return c
    const next = { ...c }
    if (conv.ultima_atividade != null) next.ultima_atividade = conv.ultima_atividade
    if (conv.nome_contato_cache != null && conv.nome_contato_cache !== '') next.nome_contato_cache = conv.nome_contato_cache
    if (conv.foto_perfil_contato_cache != null) next.foto_perfil_contato_cache = conv.foto_perfil_contato_cache
    if (conv.ultima_mensagem_preview != null) next.ultima_mensagem_preview = conv.ultima_mensagem_preview
    if (conv.tem_novas_mensagens === true) { next.tem_novas_mensagens = true; next.lida = false }
    return next
  }))
})
```

### atualizar_conversa
**Importante:** O backend só emite quando NÃO é mensagem nova (ex.: status, transferência). Se o frontend usa para refetch:

- **Lista de conversas:** pode refetchar GET /chats; as mensagens já estão no banco.
- **Mensagens do chat aberto:** **NÃO** refetchar ao receber `atualizar_conversa` após `nova_mensagem`. A mensagem já foi adicionada via socket. Refetch pode causar "aparecer e sumir" se houver latência.

### Regra de ouro
**Nunca substituir** o array de mensagens do chat aberto por um refetch quando se acabou de receber `nova_mensagem` no mesmo segundo. Preferir sempre **upsert** (adicionar ou atualizar por id/whatsapp_id).
