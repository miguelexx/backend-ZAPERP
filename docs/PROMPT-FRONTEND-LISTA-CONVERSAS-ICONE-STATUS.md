# Prompt Frontend — Ícone e Status na Lista de Conversas

Use este prompt ao implementar ou corrigir a exibição do ícone e do status de atendimento na lista lateral de conversas.

---

## Objetivo

1. **Ícone igual ao cabeçalho:** O avatar/foto de perfil exibido em cada item da lista de conversas deve ser **o mesmo** que aparece no cabeçalho do contato quando a conversa está aberta.
2. **Status "Finalizada" visível na lista:** Quando o atendimento estiver finalizado (`status_atendimento === 'fechada'`), o ícone na lista deve indicar visualmente esse status (ex.: ícone acinzentado/opaco ou badge "Finalizada" junto ao avatar).

---

## Dados da API

### GET /chats (listar conversas)

Cada item da lista retorna:

| Campo | Tipo | Uso |
|-------|------|-----|
| `id` | number | ID da conversa |
| `contato_nome` | string | Nome do contato (ex.: "Wagner Mendonça") |
| `foto_perfil` | string \| null | URL da foto de perfil do contato ( mesma fonte do cabeçalho) |
| `status_atendimento` | string | `'aberta'` \| `'em_atendimento'` \| `'fechada'` |
| `foto_grupo` | string \| null | Para grupos: foto do grupo |
| `is_group` | boolean | true = grupo; false = contato individual |

- **Contatos individuais:** usar `foto_perfil` como `src` do avatar.
- **Grupos:** usar `foto_grupo` ou avatar genérico de grupo.

### Socket `conversa_atualizada`

O payload pode incluir `foto_perfil`, `foto_perfil_contato_cache` e `status_atendimento`. Fazer **merge defensivo** — só sobrescrever campos que vêm definidos:

```javascript
socket.on('conversa_atualizada', (payload) => {
  setConversas(prev => prev.map(c => {
    if (c.id !== payload.id) return c
    const next = { ...c }
    if (payload.foto_perfil != null && payload.foto_perfil !== '') {
      next.foto_perfil = payload.foto_perfil
      next.foto_perfil_contato_cache = payload.foto_perfil_contato_cache ?? payload.foto_perfil
    }
    if (payload.status_atendimento != null) next.status_atendimento = payload.status_atendimento
    // ... outros campos (contato_nome, ultima_atividade, etc.)
    return next
  }))
})
```

---

## Implementação visual

### 1. Avatar na lista (igual ao cabeçalho)

- Usar a **mesma lógica** do cabeçalho do contato:
  - Se `foto_perfil` existe e é URL válida → `<img src={foto_perfil} alt="" className="avatar" />`
  - Caso contrário → fallback: iniciais do `contato_nome` ou ícone de pessoa/contato
- Tamanho sugerido na lista: ~40–48px (circular).
- Para grupos: `foto_grupo` ou ícone de grupo.

### 2. Status "Finalizada" no ícone

Quando `status_atendimento === 'fechada'`:

- **Opção A:** Avatar com opacidade reduzida (ex.: `opacity: 0.6`) ou filtro `grayscale`
- **Opção B:** Badge/pílula "Finalizada" ao lado ou sobre o avatar (como no cabeçalho)
- **Opção C:** Borda ou indicador visual discreto no canto do avatar (ex.: ícone de check ou cadeado)

O ideal é que o visual na lista seja **consistente** com o badge "Finalizada" que já existe no cabeçalho do contato.

### 3. Consistência cabeçalho ↔ lista

A fonte da foto é a mesma: `foto_perfil` (que vem de `clientes.foto_perfil` ou `conversas.foto_perfil_contato_cache`). Portanto, o avatar na lista e no cabeçalho devem ser idênticos quando a conversa está selecionada.

---

## Exemplo React (pseudo-código)

```tsx
// Item da lista de conversas
function ConversationListItem({ conversa }) {
  const { id, contato_nome, foto_perfil, status_atendimento, is_group, foto_grupo } = conversa
  const fotoSrc = is_group ? foto_grupo : foto_perfil
  const isFinalizada = status_atendimento === 'fechada'

  return (
    <div className="conversation-item" onClick={() => selectConversation(id)}>
      <div className={`avatar-wrapper ${isFinalizada ? 'avatar-finalizada' : ''}`}>
        {fotoSrc ? (
          <img src={fotoSrc} alt="" className="avatar" />
        ) : (
          <div className="avatar-iniciais">
            {getIniciais(contato_nome)}
          </div>
        )}
        {isFinalizada && <span className="badge-finalizada">Finalizada</span>}
      </div>
      <div className="conversation-info">
        <span className="contact-name">{contato_nome}</span>
        {/* preview, hora, etc. */}
      </div>
    </div>
  )
}
```

```css
.avatar-finalizada {
  opacity: 0.7;
}
.badge-finalizada {
  position: absolute;
  bottom: 0;
  right: 0;
  font-size: 10px;
  background: #f59e0b;
  color: white;
  padding: 1px 4px;
  border-radius: 4px;
}
```

---

## Checklist

- [ ] Avatar na lista usa `foto_perfil` (contatos) ou `foto_grupo` (grupos) — mesma fonte do cabeçalho
- [ ] Fallback quando não há foto: iniciais ou ícone genérico
- [ ] Quando `status_atendimento === 'fechada'`, ícone indica "Finalizada" (opacidade, badge ou estilo)
- [ ] `conversa_atualizada`: merge de `foto_perfil` e `status_atendimento` (merge defensivo)
- [ ] Visual consistente entre lista e cabeçalho do contato
