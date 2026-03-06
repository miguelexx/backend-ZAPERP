# Correções Frontend — Bugs Críticos (Duplicação, Ticks, Nome)

Este documento especifica as alterações **obrigatórias** no frontend para corrigir os três bugs críticos.

---

## Bug 1 — Mensagem duplicada ("oi" aparece duas vezes)

### Causa (corrigida no backend)
O backend **não retorna mais** a mensagem completa na API. A resposta é `{ ok: true, id, conversa_id }`.
A **única fonte** para exibir a mensagem é o socket `nova_mensagem`.

Se o frontend ainda adicionar de duas fontes (API antiga + socket), haveria duplicação. Com a mudança no backend, use **apenas** o socket para exibir.

### Correção obrigatória: Usar APENAS socket + Dedupe

**API `POST /chats/:id/mensagens`** retorna `{ ok: true, id, conversa_id }` — **não retorna mensagem**.
A mensagem chega **somente** via socket `nova_mensagem`. O frontend **não deve** adicionar mensagem da resposta da API.

Ao processar `nova_mensagem`:

```javascript
// Pseudo-código — adapte ao seu estado (React, Vue, etc.)
function upsertMensagem(mensagens, nova) {
  const id = nova.id
  const waId = nova.whatsapp_id || null
  const conversaId = nova.conversa_id

  // 1) Buscar existente por id (prioridade)
  const idxById = mensagens.findIndex(m => m.id === id)
  if (idxById >= 0) {
    mensagens[idxById] = { ...mensagens[idxById], ...nova }
    return mensagens
  }

  // 2) Se whatsapp_id presente, buscar por (conversa_id + whatsapp_id)
  if (waId && conversaId) {
    const idxByWa = mensagens.findIndex(m =>
      m.conversa_id === conversaId && (m.whatsapp_id || '').toString() === String(waId)
    )
    if (idxByWa >= 0) {
      mensagens[idxByWa] = { ...mensagens[idxByWa], ...nova, id }
      return mensagens
    }
  }

  // 3) Não existe — adicionar
  return [...mensagens, nova]
}
```

### Regra de ouro
- **Nunca** fazer `append` cego. Sempre verificar se a mensagem já existe (por `id` ou `whatsapp_id` na mesma conversa).
- Ao **enviar** mensagem: use **apenas uma fonte** para adicionar — ou a resposta da API **ou** o socket. Com dedupe, ambos podem chegar; o merge evita duplicata.

---

## Bug 2 — Seta/ticks bugados

### Causa
Quando há mensagens duplicadas, o evento `status_mensagem` atualiza apenas **uma** delas (por `mensagem_id` ou `whatsapp_id`). A outra bolha fica com status antigo (ex.: ✓ em vez de ✓✓).

### Correção
- Resolver o Bug 1 (dedupe) — os ticks voltam a funcionar.
- Ao processar `status_mensagem`, atualizar **todas** as mensagens que correspondam:

```javascript
socket.on('status_mensagem', ({ mensagem_id, conversa_id, status, whatsapp_id }) => {
  setMensagens(prev => prev.map(m => {
    const matchById = m.id === mensagem_id
    const matchByWa = whatsapp_id && m.conversa_id === conversa_id &&
      String(m.whatsapp_id || '') === String(whatsapp_id)
    if (matchById || matchByWa) {
      return { ...m, status, status_mensagem: status }
    }
    return m
  }))
})
```

---

## Bug 3 — Nome do contato muda/buga até dar F5

### Causa
O frontend faz **merge** do payload `conversa_atualizada` com o estado da conversa. Se o payload vier com `contato_nome: undefined` ou campos vazios, o merge sobrescreve o nome com vazio.

### Correção: Merge apenas campos definidos

```javascript
socket.on('conversa_atualizada', (payload) => {
  setConversas(prev => prev.map(c => {
    if (c.id !== payload.id) return c
    // Só sobrescrever campos que vêm definidos e não vazios
    const next = { ...c }
    if (payload.contato_nome != null && payload.contato_nome !== '') {
      next.contato_nome = payload.contato_nome
      next.nome_contato_cache = payload.nome_contato_cache ?? payload.contato_nome
    }
    if (payload.foto_perfil != null && payload.foto_perfil !== '') {
      next.foto_perfil = payload.foto_perfil
      next.foto_perfil_contato_cache = payload.foto_perfil_contato_cache ?? payload.foto_perfil
    }
    if (payload.ultima_atividade != null) next.ultima_atividade = payload.ultima_atividade
    return next
  }))
})
```

### Regra
- **Nunca** fazer `{ ...conversa, ...payload }` se o payload pode ter `contato_nome: undefined`.
- O backend já foi ajustado para enriquecer `conversa_atualizada` com nome/foto quando o payload é mínimo. O frontend deve fazer merge defensivo.

---

## Checklist de implementação

- [ ] **nova_mensagem**: upsert por `id` e `(conversa_id, whatsapp_id)` — nunca append cego
- [ ] **Resposta da API** ao enviar: usar upsert, não append
- [ ] **status_mensagem**: atualizar por `mensagem_id` **e** por `whatsapp_id` na mesma conversa
- [ ] **conversa_atualizada**: merge apenas campos definidos; não sobrescrever nome/foto com vazio
- [ ] **Listeners socket**: garantir que não há listeners duplicados (ex.: por reconexão sem cleanup)

---

## Multi-tenant

Sempre filtrar por `company_id` do usuário logado. Os eventos vêm para `empresa_{company_id}` e `conversa_{conversa_id}`; o frontend deve ignorar eventos de outras empresas.
