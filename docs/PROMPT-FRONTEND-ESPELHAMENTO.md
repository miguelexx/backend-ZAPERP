# Prompt para Frontend — Espelhamento WhatsApp

Use este prompt completo ao implementar ou corrigir o tratamento de eventos de chat no frontend:

---

## PROMPT

O backend de chat usa Socket.IO para envio em tempo real. Corrija o frontend para que as mensagens enviadas pelo celular e recebidas de contatos apareçam e **permaneçam visíveis** no sistema (espelhamento WhatsApp).

### Problema que deve ser resolvido
- **"Mensagem aparece e some"**: mensagens que chegam via socket desaparecem logo em seguida.
- **Causa**: o frontend faz refetch (GET /chats ou GET /chats/:id) ao receber `atualizar_conversa` e **substitui** o estado. Isso sobrescreve mensagens recém-adicionadas via `nova_mensagem`.

### Regras obrigatórias

1. **nova_mensagem** — ÚNICA fonte para adicionar mensagens no chat aberto. Fazer **upsert** (nunca append cego):
   - Se existe por `id` → atualizar
   - Se existe por `conversa_id` + `whatsapp_id` → atualizar
   - Caso contrário → adicionar ao array

2. **conversa_atualizada** — Atualizar o item na lista lateral. O payload pode trazer `telefone`, `cliente_id`, `ultima_mensagem_preview` (objeto com `texto`, `criado_em`, `direcao` — **sem id**). Usar **apenas para preview** na lista lateral; **NUNCA** adicionar ao array de mensagens do chat (evita duplicata/bolha no topo). Fazer **merge defensivo**: só sobrescrever campos que vêm definidos; nunca sobrescrever com `undefined` ou string vazia (evita nome/foto/contato sumirem da lista). O backend envia `telefone` e `cliente_id` ao enviar mensagem para manter a deduplicação estável.

3. **atualizar_conversa** — O backend **não emite mais** quando é mensagem nova. Quando emitir (status, transferência etc.):
   - Pode refetchar a **lista** (GET /chats)
   - **NÃO** refetchar as **mensagens** do chat aberto — isso causa "aparecer e sumir"

4. **status_mensagem** — Atualizar ticks (✓✓) na mensagem. Match por `mensagem_id` **ou** por `whatsapp_id` na mesma conversa.

5. **Resposta da API** ao enviar (POST /chats/:id/mensagens) — Retorna `{ ok, id, conversa_id }` **sem** o objeto mensagem. A mensagem chega só via `nova_mensagem`. Não adicionar nada da resposta da API.

### Implementação sugerida (React)

```javascript
// UPSERT: evita duplicata e "aparecer e sumir"
function upsertMensagem(prev, nova) {
  const idxById = prev.findIndex(m => m.id === nova.id)
  if (idxById >= 0) return prev.map((m, i) => i === idxById ? { ...m, ...nova } : m)
  const waId = nova.whatsapp_id || null
  const convId = nova.conversa_id
  if (waId && convId) {
    const idxByWa = prev.findIndex(m => m.conversa_id === convId && String(m.whatsapp_id || '') === String(waId))
    if (idxByWa >= 0) return prev.map((m, i) => i === idxByWa ? { ...m, ...nova, id: nova.id } : m)
  }
  return [...prev, nova]
}

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
})

socket.on('conversa_atualizada', (payload) => {
  setConversas(prev => prev.map(c => {
    if (c.id !== payload.id) return c
    const next = { ...c }
    if (payload.ultima_atividade != null) next.ultima_atividade = payload.ultima_atividade
    if (payload.contato_nome != null && payload.contato_nome !== '') next.contato_nome = payload.contato_nome
    if (payload.nome_contato_cache != null && payload.nome_contato_cache !== '') next.nome_contato_cache = payload.nome_contato_cache
    if (payload.foto_perfil != null && payload.foto_perfil !== '') next.foto_perfil = payload.foto_perfil
    if (payload.foto_perfil_contato_cache != null && payload.foto_perfil_contato_cache !== '') next.foto_perfil_contato_cache = payload.foto_perfil_contato_cache
    // ultima_mensagem_preview: só preview na lista — NUNCA adicionar às mensagens (não tem id)
    if (payload.ultima_mensagem_preview != null) next.ultima_mensagem_preview = payload.ultima_mensagem_preview
    // retrocompatibilidade com ultima_mensagem (se vier sem id, tratar como preview)
    if (payload.ultima_mensagem != null && !payload.ultima_mensagem.id) next.ultima_mensagem_preview = payload.ultima_mensagem
    if (payload.tem_novas_mensagens === true) { next.tem_novas_mensagens = true; next.lida = false }
    return next
  }))
})

// NÃO refetchar mensagens do chat aberto ao receber atualizar_conversa
socket.on('atualizar_conversa', ({ id }) => {
  // Opcional: refetchar só a LISTA (GET /chats), nunca as mensagens do chat aberto
})

socket.on('status_mensagem', ({ mensagem_id, conversa_id, status, whatsapp_id }) => {
  setMensagens(prev => prev.map(m => {
    const match = m.id === mensagem_id || (whatsapp_id && m.conversa_id === conversa_id && String(m.whatsapp_id || '') === String(whatsapp_id))
    return match ? { ...m, status, status_mensagem: status } : m
  }))
})
```

### Badge "Aberta"
- **`exibir_badge_aberta`** (boolean): Indica se a conversa deve exibir o ícone/label "Aberta". É `true` apenas quando há movimentação: mensagem recebida, mensagem enviada ou conversa assumida. Sem movimentação, deve ser `false` — não exibir nenhum badge.
- Usar este campo em vez de `status_atendimento` para decidir se mostra o badge "Aberta" na lista.
- `conversa_atualizada` pode trazer `exibir_badge_aberta: true` quando chega mensagem ou usuário assume.

### Checklist
- [ ] `nova_mensagem`: upsert por id e (conversa_id, whatsapp_id)
- [ ] `nova_mensagem` direcao 'in': incrementar unread_count na lista
- [ ] `conversa_atualizada`: merge defensivo (nunca sobrescrever com undefined)
- [ ] `conversa_atualizada`: usar `ultima_mensagem_preview` para preview na lista (sem id, nunca adicionar às mensagens)
- [ ] `atualizar_conversa`: NÃO refetchar mensagens do chat aberto
- [ ] `status_mensagem`: match por mensagem_id ou whatsapp_id
- [ ] API enviar mensagem: não adicionar da resposta, só do socket
