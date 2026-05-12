# Prompt Frontend — Cartão de Contato na Lista de Conversas

## Problema

Na **lista lateral de conversas** (sidebar), quando a última mensagem é um **contato compartilhado** (VCard), o preview exibe o texto bruto `BEGIN:VCARD VERSION:3.0 N:;Miguel;;; FN:Mi...` em vez do cartão de contato.

O cartão já funciona corretamente **dentro do chat** (área principal). O ajuste é apenas no **preview da lista**.

---

## Objetivo

Exibir o **cartão de contato** (ou uma versão compacta) no preview de cada item da lista lateral, em vez do vCard bruto.

---

## Dados disponíveis

O backend **GET /chats** (listarConversas) envia cada conversa com:

- `ultima_mensagem`: objeto da última mensagem
  - `texto`: string (pode ser vCard bruto)
  - `tipo`: `"contact"` | `"text"` | `"imagem"` | etc.
  - `criado_em`, `direcao`, `contact_meta` (quando tipo === 'contact')

Quando `tipo === 'contact'`, o `contact_meta` vem preenchido:

```json
{
  "contact_meta": {
    "nome": "Miguel",
    "telefone": "+55 34 99991-1246",
    "foto_perfil": "https://..." | null,
    "descricao_negocio": null
  }
}
```

---

## Regras de implementação

1. **Detecção**: Ao renderizar o preview da conversa na lista, verificar:
   - `ultima_mensagem?.tipo === 'contact'` **OU**
   - `ultima_mensagem?.texto?.includes?.('BEGIN:VCARD')` (fallback para dados antigos sem tipo)

2. **Exibição** (escolher uma abordagem):

   **Opção A — Mini cartão (recomendado):**  
   Exibir um card compacto com:
   - Avatar pequeno (ou iniciais)
   - Nome (`contact_meta.nome` ou parse do vCard)
   - Telefone formatado
   - Ícone "📇" ou similar como indicador de contato

   **Opção B — Placeholder simples:**  
   Exibir texto fixo: `📇 Contato: [nome]` (ex: `📇 Contato: Miguel`)

3. **Fallback**: Se `contact_meta` for `null` e o texto for vCard bruto, extrair nome e telefone do texto (regex para `FN:`, `TEL:`) ou exibir apenas `📇 Contato` sem detalhes.

4. **Reutilização**: Usar o mesmo componente de cartão do chat, se possível, em versão compacta; ou um subcomponente mínimo (avatar + nome + telefone).

5. **Socket `conversa_atualizada`**: O backend envia `ultima_mensagem_preview` com `tipo` e `contact_meta` quando a última mensagem é contato. Aplicar a mesma lógica ao fazer merge do preview na lista.

---

## Exemplo React (visão geral)

```tsx
function ConversationListPreview({ conv }) {
  const last = conv.ultima_mensagem || conv.mensagens?.[0]
  if (!last) return null

  const isContact = last.tipo === 'contact' || last.texto?.includes?.('BEGIN:VCARD')
  const meta = last.contact_meta

  if (isContact) {
    const nome = meta?.nome || extrairNomeVCard(last.texto) || 'Contato'
    const telefone = meta?.telefone || extrairTelefoneVCard(last.texto)
    return (
      <div className="preview-contact-card">
        <Avatar src={meta?.foto_perfil} fallback={nome} size="sm" />
        <span className="preview-contact-name">{nome}</span>
        {telefone && <span className="preview-contact-phone">{formatPhone(telefone)}</span>}
      </div>
    )
  }

  return <span className="preview-text">{truncate(last.texto, 50)}</span>
}
```

---

## Checklist

- [ ] Preview da lista verifica `tipo === 'contact'` ou vCard em `texto`
- [ ] Exibe cartão/placeholder em vez do vCard bruto
- [ ] Usa `contact_meta` quando existir
- [ ] Fallback quando `contact_meta` for null (parse do vCard ou "📇 Contato")
- [ ] Socket `conversa_atualizada`: ao atualizar `ultima_mensagem_preview`, aplicar a mesma lógica quando for contato
