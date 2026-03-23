# Prompt para Frontend — Cartão de Contato (WhatsApp)

Use este prompt ao implementar a exibição visual e funcional de mensagens de **contato compartilhado** no chat, espelhando o layout do WhatsApp.

---

## Objetivo

Quando o usuário **envia** ou **recebe** um contato (cartão de contato do WhatsApp), a mensagem deve aparecer como um cartão visual dentro do balão, com:

- **Foto de perfil** do contato (circular)
- **Nome** do contato
- **Horário** e **status** (✓✓ entregue/lido)
- **Botões de ação**: "Conversar" e "Adicionar a um grupo"

O visual deve ser igual ao da interface do WhatsApp (balão verde claro, rabo à esquerda, foto circular, botões em verde escuro).

---

## Estrutura de dados (Backend)

### Mensagem de contato (`tipo === 'contact'`)

Cada mensagem de contato possui:

```json
{
  "id": 123,
  "texto": "Nome do Contato",
  "tipo": "contact",
  "direcao": "in | out",
  "criado_em": "2025-03-15T16:14:00.000Z",
  "status": "sent | delivered | read",
  "whatsapp_id": "3EB0...",
  "contact_meta": {
    "nome": "Carlos ACM Trabalho",
    "telefone": "553498838263",
    "foto_perfil": "https://...",
    "descricao_negocio": "Artefatos de Cimento Mendonça"
  }
}
```

- **`texto`**: Nome do contato (fallback legível)
- **`contact_meta`**: Metadados para exibir o cartão
  - `nome` (string): Nome para exibição
  - `telefone` (string): Número em formato internacional (ex: 5511999999999)
  - `foto_perfil` (string | null): URL da foto de perfil (pode não existir)
  - `descricao_negocio` (string | null): Descrição do negócio (WhatsApp Business, ex: "Artefatos de Cimento Mendonça")

### APIs e eventos

- **GET /chats/:id** (detalharChat): mensagens incluem `contact_meta` quando `tipo === 'contact'`
- **Socket `nova_mensagem`**: payload inclui `tipo` e `contact_meta` para contatos
- **POST /chats/:id/contatos**: envia contato; a mensagem chega via `nova_mensagem` com `contact_meta`

---

## Layout visual (referência WhatsApp)

1. **Balão da mensagem**
   - Cor: verde claro (#dcf8c6 ou similar) para `direcao === 'out'`; cinza claro para `direcao === 'in'`
   - Raio de borda arredondado
   - "Rabo" triangular à esquerda

2. **Seção superior do cartão**
   - **Foto**: avatar circular (~48px), fallback para iniciais ou ícone de contato
   - **Nome**: negrito, tamanho maior
   - **Descrição do negócio** (opcional): se `contact_meta.descricao_negocio` existir, exibir em texto menor/cinza abaixo do nome
   - **Horário** (criado_em formatado) e **status** (✓ pendente, ✓✓ enviado, ✓✓ lido em verde)

3. **Divisor** sutil entre seção de informações e ações

4. **Seção de ações**
   - Botão "Conversar" (texto verde escuro, clicável)
   - Botão "Adicionar a um grupo" (texto verde escuro, clicável)

5. **Encaminhar**: ícone circular à esquerda do balão (seta curva) — opcional, alinhado com outras mensagens

---

## Funcionalidade dos botões

### "Conversar"
- Deve abrir/iniciar uma conversa com o contato compartilhado.
- Implementação sugerida:
  - Buscar ou criar conversa pelo telefone (`contact_meta.telefone`)
  - Navegar para a conversa (ex: `/chats/:conversa_id` ou abrir drawer/modal da conversa)
- Endpoint: `GET /chats` com filtro por telefone, ou `POST /chats` para criar nova conversa se não existir.

### "Adicionar a um grupo"
- Deve permitir adicionar o contato a um grupo.
- Implementação sugerida:
  - Abrir modal/tela de seleção de grupos
  - Ao escolher grupo, disparar ação de adicionar participante (depende da API disponível)
- Nota: WhatsApp Business API pode ter restrições; verificar suporte do provider (UltraMsg/Z-API).

---

## Implementação React (exemplo)

```tsx
// Componente de mensagem de contato
function MessageContactCard({ msg }: { msg: Mensagem }) {
  const { contact_meta, criado_em, status, direcao } = msg
  const meta = contact_meta || { nome: msg.texto, telefone: null, foto_perfil: null }
  
  const handleConversar = () => {
    // Buscar/criar conversa pelo meta.telefone e navegar
    router.push(`/chats?phone=${meta.telefone}`)
  }
  
  const handleAdicionarGrupo = () => {
    // Abrir modal de grupos
    openAddToGroupModal(meta.telefone)
  }

  return (
    <div className={`bubble ${direcao === 'out' ? 'bubble-out' : 'bubble-in'}`}>
      <div className="contact-card">
        <div className="contact-card-header">
          <img 
            src={meta.foto_perfil || '/avatar-placeholder.svg'} 
            alt="" 
            className="contact-avatar"
          />
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
          <button onClick={handleAdicionarGrupo}>Adicionar a um grupo</button>
        </div>
      </div>
    </div>
  )
}
```

---

## Regras de exibição

1. **Detecção**: Sempre verificar `msg.tipo === 'contact'` para renderizar o cartão. O backend agora detecta vCards em texto bruto e salva com `tipo: 'contact'` e `contact_meta` preenchido.
2. **Fallback**: Se `contact_meta` for `null` ou ausente, exibir apenas `texto` como mensagem comum (evita mostrar vCard bruto).
2. **Foto**: Se `foto_perfil` não existir, usar avatar genérico ou iniciais do nome.
3. **Telefone**: Formatar para exibição (ex: +55 11 99999-9999) quando disponível.
4. **Direção**: Mesmo layout para `in` e `out`; apenas cores do balão mudam.
5. **Socket**: Ao receber `nova_mensagem` com `tipo === 'contact'`, aplicar o mesmo componente de cartão (upsert por id ou whatsapp_id).

---

## Checklist

- [ ] Mensagens com `tipo === 'contact'` renderizam como cartão (não como texto simples)
- [ ] Foto, nome, horário e status visíveis
- [ ] Botão "Conversar" funcional (abre conversa com o contato)
- [ ] Botão "Adicionar a um grupo" com ação definida (modal ou integração)
- [ ] Layout responsivo e alinhado ao estilo WhatsApp
- [ ] Fallback quando `contact_meta` ausente
- [ ] Integração com `nova_mensagem` (cartão aparece em tempo real)
