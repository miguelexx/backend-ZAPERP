# Frontend: Lista de Conversas com Reordenação Suave

## Problema
Ao enviar mensagem pelo sistema, o contato na lista "desce" e depois "sobe" — parece bugado.

## Causa
Refetch da lista ao receber `atualizar_conversa` ou múltiplas atualizações em ordem incorreta causam re-render brusco.

## Correção no Backend
- O backend emite `conversa_atualizada` com `reordenar_suave: true` ao enviar mensagem.
- **Não** emite `atualizar_conversa` em reconciliação (mensagem enviada pelo sistema) — evita refetch desnecessário.

## Implementação no Frontend

### 1. Ao receber `conversa_atualizada` com `reordenar_suave`

```javascript
socket.on('conversa_atualizada', (payload) => {
  setConversas(prev => {
    const updated = prev.map(c => {
      if (c.id !== payload.id) return c
      const next = { ...c }
      if (payload.ultima_atividade != null) next.ultima_atividade = payload.ultima_atividade
      if (payload.nome_contato_cache != null && payload.nome_contato_cache !== '') next.nome_contato_cache = payload.nome_contato_cache
      if (payload.ultima_mensagem_preview != null) next.ultima_mensagem_preview = payload.ultima_mensagem_preview
      // ... outros campos
      return next
    })
    // REORDENAR por ultima_atividade (mais recente no topo)
    if (payload.reordenar_suave) {
      return [...updated].sort((a, b) => 
        new Date(b.ultima_atividade || 0).getTime() - new Date(a.ultima_atividade || 0).getTime()
      )
    }
    return updated
  })
})
```

### 2. Animação suave (recomendado)
Use `transition` CSS ou biblioteca (ex: `framer-motion`, `react-flip-toolkit`) para animar o movimento do item quando muda de posição:

```css
.conversa-item {
  transition: transform 0.25s ease, opacity 0.2s ease;
}
```

Ou com `framer-motion`:
```jsx
<AnimatePresence>
  {conversas.map((c, i) => (
    <motion.div
      key={c.id}
      layout
      transition={{ duration: 0.2, ease: "easeOut" }}
    >
      {/* conteúdo */}
    </motion.div>
  ))}
</AnimatePresence>
```

### 3. NÃO refetchar ao receber `atualizar_conversa` após envio
Se o usuário acabou de enviar mensagem (últimos 3–5s), **não** refetchar a lista ao receber `atualizar_conversa`. O `conversa_atualizada` já traz os dados necessários.

### 4. Seta de visualização (ticks ✓✓)
Garantir que `status_mensagem` atualize corretamente:

```javascript
socket.on('status_mensagem', ({ mensagem_id, conversa_id, status, whatsapp_id }) => {
  setMensagens(prev => prev.map(m => {
    const match = m.id === mensagem_id || 
      (whatsapp_id && m.conversa_id === conversa_id && String(m.whatsapp_id || '') === String(whatsapp_id))
    return match ? { ...m, status, status_mensagem: status } : m
  }))
})
```

**Status canônicos:** `pending` | `sending` | `sent` | `delivered` | `read` | `played` | `erro`

## Checklist
- [ ] Merge defensivo em `conversa_atualizada` (nunca sobrescrever com `undefined`)
- [ ] Reordenar lista por `ultima_atividade` quando `reordenar_suave: true`
- [ ] Animação de layout (CSS transition ou motion) para movimento suave
- [ ] Não refetchar lista em 3–5s após envio de mensagem
- [ ] `status_mensagem`: match por `mensagem_id` **e** `whatsapp_id` para ticks ✓✓
