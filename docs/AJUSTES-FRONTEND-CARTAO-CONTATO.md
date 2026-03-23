# Ajustes de Frontend — Cartão de Contato (WhatsApp)

## Resumo

O backend foi ajustado para **detectar e tratar contatos compartilhados** corretamente. Quando alguém envia um contato pelo celular, o sistema agora:

1. Detecta o vCard no texto (mesmo quando vem como `type: chat`)
2. Salva com `tipo: 'contact'` e `contact_meta` preenchido
3. Nunca mais exibe o vCard bruto como texto

**O frontend precisa renderizar mensagens com `tipo === 'contact'` como um cartão visual**, igual ao WhatsApp.

---

## O que implementar no frontend

### 1. Verificar o tipo da mensagem

No componente que renderiza cada mensagem do chat:

```tsx
if (msg.tipo === 'contact') {
  return <MessageContactCard msg={msg} />
}
// Caso contrário, renderiza como texto/mídia normal
```

### 2. Componente do cartão de contato

```tsx
function MessageContactCard({ msg }) {
  const { contact_meta, criado_em, status, direcao } = msg
  const meta = contact_meta || { nome: msg.texto, telefone: null, foto_perfil: null, descricao_negocio: null }

  const handleConversar = () => {
    // Navegar para conversa com meta.telefone
    router.push(`/chats?phone=${meta.telefone}`)
  }

  return (
    <div className={`bubble ${direcao === 'out' ? 'bubble-out' : 'bubble-in'}`}>
      <div className="contact-card">
        <div className="contact-card-header">
          <img src={meta.foto_perfil || '/avatar-placeholder.svg'} alt="" className="contact-avatar" />
          <div className="contact-info">
            <span className="contact-name">{meta.nome || 'Contato'}</span>
            {meta.descricao_negocio && (
              <span className="contact-business-desc">{meta.descricao_negocio}</span>
            )}
            <span className="contact-time">
              {formatTime(criado_em)}
              <StatusIcon status={status} />
            </span>
          </div>
        </div>
        <div className="contact-card-divider" />
        <div className="contact-card-actions">
          <button onClick={handleConversar}>Conversar</button>
          <button onClick={() => openAddToGroupModal(meta.telefone)}>Adicionar a um grupo</button>
        </div>
      </div>
    </div>
  )
}
```

### 3. Estrutura de `contact_meta`

```ts
{
  nome: string | null        // Ex: "Carlos ACM Trabalho"
  telefone: string | null     // Ex: "553498838263"
  foto_perfil: string | null // URL ou null
  descricao_negocio?: string | null  // Ex: "Artefatos de Cimento Mendonça" (WhatsApp Business)
}
```

### 4. Estilos sugeridos (CSS)

- **Balão**: verde claro (#dcf8c6) para `out`, cinza para `in`
- **Avatar**: circular ~48px
- **Nome**: negrito, fonte maior
- **Descrição negócio**: texto menor, cor cinza
- **Botões**: texto verde escuro (#075E54 ou similar), sem borda

---

## Checklist

- [ ] Mensagens com `tipo === 'contact'` renderizam como cartão (não como texto)
- [ ] Nome, descrição do negócio (se houver) e horário visíveis
- [ ] Botão "Conversar" abre conversa com o contato
- [ ] Fallback: se `contact_meta` for null, exibir `texto` como mensagem comum (evita vCard bruto)

---

## Documentação completa

Ver `docs/PROMPT-FRONTEND-CARTAO-CONTATO.md` para layout detalhado e referência do WhatsApp.
