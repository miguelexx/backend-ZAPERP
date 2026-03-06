# Status de Visualização em Tempo Real — Frontend

## Problema
O status de visualização (ticks ✓✓) não atualizava em tempo real ao enviar mensagem — era necessário atualizar a página.

## Correções no Backend (aplicadas)
O backend agora emite `status_mensagem` para **três rooms**:
- `empresa_{company_id}` — todos os usuários da empresa
- `conversa_{conversa_id}` — quem está visualizando a conversa (precisa chamar `join_conversa`)
- `usuario_{autor_usuario_id}` — **quem enviou a mensagem** (garante que o remetente receba mesmo sem `join_conversa`)

## O que o Frontend DEVE fazer

### 1. Escutar o evento `status_mensagem`
```javascript
socket.on('status_mensagem', ({ mensagem_id, conversa_id, status, whatsapp_id }) => {
  // Atualizar a mensagem no estado local
  setMensagens(prev => prev.map(m => {
    const match = (whatsapp_id && m.whatsapp_id === whatsapp_id) || 
                  (mensagem_id && m.id === mensagem_id)
    if (!match || m.conversa_id !== conversa_id) return m
    return { ...m, status, status_mensagem: status }
  }))
})
```

### 2. Atualizar por `whatsapp_id` E por `mensagem_id`
O WhatsApp pode enviar o status antes do frontend ter o `mensagem_id` interno. Use **ambos** para deduplicar:
- `whatsapp_id` — ID da mensagem no WhatsApp (prioridade para mensagens recém-enviadas)
- `mensagem_id` — ID interno no banco

### 3. Chamar `join_conversa` ao abrir um chat
```javascript
useEffect(() => {
  if (conversaId && socket?.connected) {
    socket.emit('join_conversa', conversaId)
  }
  return () => {
    if (conversaId && socket?.connected) {
      socket.emit('leave_conversa', conversaId)
    }
  }
}, [conversaId, socket])
```

### 4. Conectar o socket com token
O socket precisa estar conectado com o token JWT para entrar nas rooms corretas:
```javascript
const socket = io(SOCKET_URL, {
  auth: { token: getToken() },
  transports: ['websocket', 'polling']
})
```

## Payload do evento `status_mensagem`
```typescript
{
  mensagem_id: number
  conversa_id: number
  status: 'pending' | 'sent' | 'delivered' | 'read' | 'played' | 'erro'
  whatsapp_id?: string  // sempre presente quando disponível
}
```

## Valores de status (ticks)
- `pending` — ⏳ enviando
- `sent` — ✓ enviada
- `delivered` — ✓✓ entregue
- `read` — ✓✓ azul (visualizada)
- `played` — ✓✓ azul (áudio/vídeo reproduzido)
- `erro` — ❌ falha
