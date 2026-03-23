# Prompt para Frontend — Mensagem de Localização Clicável

Use este prompt ao implementar a exibição de mensagens de **localização** no chat, permitindo que o usuário visualize no mapa a localização enviada pelo cliente.

---

## Objetivo

Quando o **cliente** envia sua localização pelo WhatsApp, a mensagem deve aparecer no sistema de forma **clicável**, abrindo o Google Maps (ou outro serviço de mapas) para visualizar a localização enviada.

---

## Estrutura de dados (Backend)

### Mensagem de localização (`tipo === 'location'`)

Cada mensagem de localização possui:

```json
{
  "id": 456,
  "texto": "Rua ABC, 123 • São Paulo (23.5505,-46.6333)",
  "tipo": "location",
  "url": "https://www.google.com/maps?q=-23.5505,-46.6333",
  "direcao": "in | out",
  "criado_em": "2025-03-23T14:30:00.000Z",
  "status": "sent | delivered | read",
  "whatsapp_id": "3EB0...",
  "nome_arquivo": "localização"
}
```

- **`texto`**: Descrição da localização (endereço, nome do lugar e/ou coordenadas) — fallback legível
- **`url`**: Link para Google Maps no formato `https://www.google.com/maps?q=LAT,LNG` — **clicável**
- **`tipo`**: Sempre `'location'` para mensagens de localização
- **`nome_arquivo`**: Sempre `"localização"` (pode ser ignorado no frontend)

### APIs e eventos

- **GET /chats/:id** (detalharChat): mensagens incluem `tipo: 'location'` e `url` quando for localização
- **Socket `nova_mensagem`**: payload inclui `tipo: 'location'` e `url` para localizações recebidas
- **POST /chats/:id/localizacao**: envia localização; a mensagem chega via `nova_mensagem` com `tipo: 'location'`

---

## Implementação no frontend

### Regra de detecção

```javascript
// Sempre verificar o tipo da mensagem
if (msg.tipo === 'location') {
  // Renderizar componente de localização clicável
}
```

### Componente (exemplo React)

```tsx
function MessageLocation({ msg }: { msg: Mensagem }) {
  const { texto, url, criado_em, status, direcao } = msg

  return (
    <div className={`bubble ${direcao === 'out' ? 'bubble-out' : 'bubble-in'}`}>
      <a
        href={url || `https://www.google.com/maps/search/${encodeURIComponent(texto || 'localização')}`}
        target="_blank"
        rel="noopener noreferrer"
        className="location-link"
      >
        <span className="location-icon">📍</span>
        <span className="location-text">{texto || 'Ver localização'}</span>
        <span className="location-hint">Clique para abrir no mapa →</span>
      </a>
      <span className="message-time">
        {formatTime(criado_em)}
        <StatusIcon status={status} />
      </span>
    </div>
  )
}
```

### Fallback quando `url` está ausente

Se `url` for `null` ou vazio, use o `texto` como busca no Google Maps:
```
https://www.google.com/maps/search/${encodeURIComponent(texto || 'localização')}
```

---

## Layout visual (referência WhatsApp)

1. **Balão da mensagem**
   - Cor: verde claro (`#dcf8c6`) para `direcao === 'out'`; cinza claro para `direcao === 'in'`
   - Raio de borda arredondado
   - Link clicável com efeito hover

2. **Conteúdo**
   - Ícone de localização (📍 ou similar)
   - Texto descritivo (endereço ou coordenadas)
   - Indicação visual de que é clicável ("Clique para abrir no mapa" ou ícone de link externo)

3. **Horário e status**
   - Formato HH:mm
   - Ticks de status (✓ enviado, ✓✓ entregue, ✓✓ lido)

---

## Checklist

- [ ] Mensagens com `tipo === 'location'` renderizam como link clicável (não como texto simples)
- [ ] Clique abre Google Maps em nova aba (`target="_blank"`)
- [ ] Usa `rel="noopener noreferrer"` por segurança
- [ ] Fallback quando `url` ausente: usar `texto` em `/maps/search/`
- [ ] Layout responsivo e alinhado ao estilo WhatsApp
- [ ] Integração com `nova_mensagem` (localização aparece em tempo real)
- [ ] Endpoint de envio: `POST /chats/:id/localizacao` com body `{ address?, lat, lng }`

---

## Envio de localização (atendente → cliente)

| Método | URL | Body |
|--------|-----|------|
| POST | `/api/chats/:id/localizacao` | `{ address?: string, lat: number, lng: number }` |

O `:id` é o **ID da conversa**. Os campos `lat` e `lng` são obrigatórios e devem ser números válidos (latitude e longitude).
