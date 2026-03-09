# Prompt para Frontend — Envio de Mensagem Liso (sem bugs)

Use este prompt completo ao corrigir os bugs de envio de mensagem pelo sistema. Objetivo: **experiência igual ao WhatsApp** — contato estável na lista, mensagem aparece uma única vez como última, tudo em tempo real sem glitches.

---

## PROBLEMAS A RESOLVER

1. **Contato some da lista por um momento** — Ao enviar, a conversa desaparece e volta
2. **Mensagem aparece no meio da conversa** — Posição errada, só depois volta ao normal
3. **Nome do contato muda automaticamente** — Deve ficar fixo independente da situação
4. **Mensagem duplicada** — Deve aparecer apenas uma vez
5. **Mensagem não como última** — Deve sempre aparecer como última mensagem da conversa

---

## REGRAS OBRIGATÓRIAS

### 1. `nova_mensagem` — ÚNICA fonte para adicionar mensagens no chat aberto

- **Upsert** (nunca append cego):
  - Se existe por `id` → atualizar
  - Se existe por `conversa_id` + `whatsapp_id` → atualizar
  - Caso contrário → adicionar
- **Ordenação**: Após upsert, **sempre** ordenar o array por `criado_em` ASC (mais antigas primeiro). Assim a nova mensagem (mais recente) fica sempre no final = última posição.
- **Uma única vez**: Nunca adicionar da resposta da API. A API retorna `{ ok, id, conversa_id }` sem objeto mensagem.

### 2. `conversa_atualizada` — Atualizar item na lista lateral (merge defensivo)

- **NUNCA** sobrescrever com `undefined` ou string vazia. O contato deve permanecer visível.
- **Só atualizar** campos que vêm definidos e não vazios.
- **Nome fixo**: Ao enviar mensagem, o backend envia `nome_contato_cache` e `contato_nome`. Se não vierem no payload, **preservar o valor atual** — nunca limpar.
- **telefone e cliente_id**: Usar para deduplicação. O backend sempre envia ao enviar mensagem.

### 3. Lista de conversas — Reordenar sem fazer contato sumir

- Ao receber `conversa_atualizada` com `ultima_atividade`:
  - Atualizar o item no array (merge defensivo)
  - Reordenar a lista por `ultima_atividade` DESC (mais recente no topo)
- **Não remover** a conversa durante o reordenamento. Atualizar no lugar e reordenar o array.
- **Key estável** no `map`: usar `conversa.id` (nunca índice).

### 4. `atualizar_conversa` — NÃO refetchar mensagens

- Quando emitir (status, transferência): pode refetchar a **lista** (GET /chats) se necessário
- **NUNCA** refetchar as **mensagens** do chat aberto — causa "aparecer e sumir"

### 5. Resposta da API ao enviar

- `POST /chats/:id/mensagens` retorna `{ ok, id, conversa_id }` — **não retorna mensagem**
- Aguardar `nova_mensagem` via socket. Não adicionar nada da resposta.

---

## IMPLEMENTAÇÃO SUGERIDA (React)

```javascript
// ========== 1. UPSERT + ORDENAÇÃO (mensagem sempre como última) ==========
function upsertMensagem(prev, nova) {
  const idxById = prev.findIndex(m => m.id === nova.id)
  if (idxById >= 0) return prev.map((m, i) => i === idxById ? { ...m, ...nova } : m)
  const waId = nova.whatsapp_id ?? null
  const convId = nova.conversa_id
  if (waId && convId) {
    const idxByWa = prev.findIndex(m => m.conversa_id === convId && String(m.whatsapp_id || '') === String(waId))
    if (idxByWa >= 0) return prev.map((m, i) => i === idxByWa ? { ...m, ...nova, id: nova.id } : m)
  }
  const appended = [...prev, nova]
  // SEMPRE ordenar por criado_em ASC — nova (mais recente) fica no final = última
  return appended.sort((a, b) => new Date(a.criado_em || 0) - new Date(b.criado_em || 0))
}

// ========== 2. MERGE DEFENSIVO — nome/foto fixos na lista ==========
function mergeConversaAtualizada(prev, payload) {
  return prev.map(c => {
    if (c.id !== payload.id) return c
    const next = { ...c }
    // Só sobrescrever quando valor definido e não vazio
    if (payload.ultima_atividade != null) next.ultima_atividade = payload.ultima_atividade
    if (payload.telefone != null && payload.telefone !== '') next.telefone = payload.telefone
    if (payload.cliente_id != null) next.cliente_id = payload.cliente_id
    if (payload.contato_nome != null && payload.contato_nome !== '') {
      next.contato_nome = payload.contato_nome
      next.nome_contato_cache = payload.nome_contato_cache ?? payload.contato_nome
    }
    if (payload.foto_perfil != null && payload.foto_perfil !== '') {
      next.foto_perfil = payload.foto_perfil
      next.foto_perfil_contato_cache = payload.foto_perfil_contato_cache ?? payload.foto_perfil
    }
    if (payload.ultima_mensagem_preview != null) next.ultima_mensagem_preview = payload.ultima_mensagem_preview
    if (payload.ultima_mensagem != null && !payload.ultima_mensagem.id) next.ultima_mensagem_preview = payload.ultima_mensagem
    if (payload.tem_novas_mensagens === true) { next.tem_novas_mensagens = true; next.lida = false }
    return next
  })
}

// ========== 3. REORDENAR LISTA (conversa no topo, sem sumir) ==========
function sortConversasByRecent(conversas) {
  return [...conversas].sort((a, b) => {
    const ta = new Date(a.ultima_atividade || a.criado_em || 0).getTime()
    const tb = new Date(b.ultima_atividade || b.criado_em || 0).getTime()
    return tb - ta
  })
}

// ========== 4. HANDLERS ==========
socket.on('nova_mensagem', (msg) => {
  if (msg.conversa_id === conversaAberta?.id) {
    setMensagens(prev => upsertMensagem(prev, msg))
  }
  if (msg.direcao === 'in') {
    setConversas(prev => prev.map(c =>
      c.id === msg.conversa_id
        ? { ...c, unread_count: (c.unread_count || 0) + 1, tem_novas_mensagens: true, lida: false }
        : c
    ))
  }
  // Atualizar conversa na lista (preview + subir para o topo)
  setConversas(prev => {
    const merged = prev.map(c => {
      if (c.id !== msg.conversa_id) return c
      return {
        ...c,
        ultima_atividade: msg.criado_em,
        ultima_mensagem_preview: { texto: msg.texto ?? '(mensagem)', criado_em: msg.criado_em, direcao: msg.direcao ?? 'in' }
      }
    })
    return sortConversasByRecent(merged)
  })
})

socket.on('conversa_atualizada', (payload) => {
  setConversas(prev => {
    const merged = mergeConversaAtualizada(prev, payload)
    return sortConversasByRecent(merged)
  })
})

socket.on('atualizar_conversa', ({ id }) => {
  // Opcional: refetchar SÓ a lista (GET /chats), NUNCA as mensagens do chat aberto
})

socket.on('status_mensagem', ({ mensagem_id, conversa_id, status, whatsapp_id }) => {
  setMensagens(prev => prev.map(m => {
    const match = m.id === mensagem_id || (whatsapp_id && m.conversa_id === conversa_id && String(m.whatsapp_id || '') === String(whatsapp_id))
    return match ? { ...m, status, status_mensagem: status } : m
  }))
})
```

---

## LISTA DE CONVERSAS — KEY E RENDER

```jsx
{conversas.map((conv) => (
  <ConversaItem
    key={conv.id}
    conversa={conv}
  />
))}
```

- **key={conv.id}** — nunca use índice. Garante que o contato não "pisque" ao reordenar.

---

## CHECKLIST

- [ ] `nova_mensagem`: upsert por `id` e `(conversa_id, whatsapp_id)`
- [ ] Após upsert: ordenar mensagens por `criado_em` ASC (última = mais recente no final)
- [ ] `conversa_atualizada`: merge defensivo — nunca sobrescrever nome/foto com vazio
- [ ] `conversa_atualizada`: reordenar lista por `ultima_atividade` DESC
- [ ] Lista: key estável `conv.id`, nunca índice
- [ ] `atualizar_conversa`: NÃO refetchar mensagens do chat aberto
- [ ] Resposta API enviar: não adicionar mensagem, só via socket
- [ ] `status_mensagem`: match por `mensagem_id` ou `whatsapp_id`

---

## RESUMO DO FLUXO AO ENVIAR MENSAGEM

1. Usuário envia → POST /chats/:id/mensagens
2. API retorna `{ ok, id, conversa_id }`
3. Backend emite `nova_mensagem` (payload completo da mensagem)
4. Backend emite `conversa_atualizada` (id, ultima_atividade, nome, foto, telefone, ultima_mensagem_preview)
5. Frontend: upsert mensagem → ordenar por criado_em ASC
6. Frontend: merge conversa na lista (defensivo) → reordenar por ultima_atividade
7. Resultado: contato permanece visível, mensagem aparece uma vez como última, tudo liso.
