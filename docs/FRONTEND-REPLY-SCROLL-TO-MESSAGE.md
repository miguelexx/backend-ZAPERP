# Frontend — Render reply_meta + Scroll-to-message (seta de resposta)

Este documento especifica as alterações necessárias no frontend para que a **seta/preview de resposta (reply)** funcione como no WhatsApp Web.

## 4.1 Render do bloco de reply dentro do balão

### Estrutura dos dados
Cada mensagem pode ter `reply_meta` no formato:
```json
{
  "replyToId": "<whatsapp_id da mensagem citada>",
  "name": "Você" | "Contato",
  "snippet": "<primeiros 120-180 chars do texto citado>",
  "ts": 1234567890
}
```

### Renderização
- Se `mensagem.reply_meta` existir:
  1. Mostrar um **mini-bloco** acima do texto principal
  2. Estilo WhatsApp: borda/linha lateral esquerda (ex: 2–3px sólida na cor do tema)
  3. Exibir `name` em negrito + `snippet` truncado (ex: 120 chars)
  4. Ao **clicar** no bloco → executar scroll até a mensagem citada

### Lógica de clique
1. Procurar mensagem por `whatsapp_id === replyToId` (preferencial)
2. Fallback: `id === replyToId` (se for ID interno)
3. Se a mensagem citada **não estiver carregada** (conversa paginada):
   - Mostrar toast: "Mensagem citada não carregada"
   - Botão "Carregar mais" ou disparar fetch das mensagens anteriores

## 4.2 "Seta de visualização" e comportamento

- A seta/preview deve aparecer quando houver `reply_meta`
- Clicar deve:
  1. Fazer scroll até a mensagem citada (usar `ref` ou `scrollIntoView`)
  2. Destacar por 1–2s (flash/outline) a mensagem citada
  3. Garantir que a lista não “pule” errado (usar refs por `messageId` ou `whatsapp_id`)

### Exemplo de ref para scroll (React/Vue)
```js
// refs: { [whatsapp_id]: DOMElement } ou { [id]: DOMElement }
const messageRefs = useRef({})

// Ao renderizar cada mensagem:
<div ref={el => { if (msg.whatsapp_id) messageRefs.current[msg.whatsapp_id] = el }}>

// Ao clicar no reply:
const scrollToReply = (replyToId) => {
  const el = messageRefs.current[replyToId]
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.add('highlight-reply')
    setTimeout(() => el.classList.remove('highlight-reply'), 1500)
  } else {
    showToast('Mensagem citada não carregada')
    // opcional: loadMoreMessages() ou similar
  }
}
```

### CSS sugerido para highlight
```css
.highlight-reply {
  animation: flash-reply 1.5s ease-out;
}
@keyframes flash-reply {
  0% { box-shadow: 0 0 0 2px var(--accent-color); }
  50% { box-shadow: 0 0 0 4px var(--accent-color); }
  100% { box-shadow: none; }
}
```

## 4.3 Espelhamento real e status

- Mensagens `fromMe` (enviadas pelo celular) chegam via socket `nova_mensagem` com `direcao: 'out'`
- Devem aparecer imediatamente no chat como mensagem **enviada** (lado direito)
- Status ticks: escutar evento `status_mensagem` com `{ mensagem_id, conversa_id, status }`
- Atualizar ícone no balão conforme:
  - `pending` → um tick
  - `sent` → dois ticks cinza
  - `delivered` → dois ticks
  - `read` / `played` → dois ticks azul

## Eventos Socket utilizados

| Evento            | Payload                                             | Uso                                           |
|-------------------|------------------------------------------------------|-----------------------------------------------|
| `nova_mensagem`   | `{ id, texto, reply_meta, whatsapp_id, status, ... }`| Inserir/atualizar mensagem na lista            |
| `status_mensagem` | `{ mensagem_id, conversa_id, status }`              | Atualizar ticks da mensagem correspondente     |
| `conversa_atualizada` | `{ id, telefone?, ... }`                        | Atualizar lista de conversas (lid→phone)       |
