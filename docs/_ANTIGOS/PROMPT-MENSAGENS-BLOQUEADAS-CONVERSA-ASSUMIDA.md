# Prompt: Bloqueio de Mensagens — Conversa Assumida por Outro Usuário

Este documento descreve as alterações feitas no **backend** e o que o **frontend** deve implementar para exibir a mensagem informativa quando o usuário clica em uma conversa assumida por outro atendente.

---

## Contexto

Quando uma conversa está **assumida** por outro usuário (ex.: João assumiu a conversa), os atendentes que **não** são o responsável não devem ver o conteúdo das mensagens. O backend já bloqueia o retorno das mensagens; o frontend precisa exibir uma mensagem clara ao usuário.

---

## Alterações realizadas no Backend

### 1. Controller `chatController.js` — `detalharChat`

**Endpoint:** `GET /chats/:id` (e paginação: `GET /chats/:id?cursor=...`)

**Comportamento implementado:**

- Quando a conversa está assumida por outro usuário (`atendente_id` ≠ usuário atual), e o usuário é **atendente** (não admin nem supervisor):
  - As mensagens **não são buscadas** no banco
  - O array `mensagens` retornado é **vazio** `[]`
  - O response inclui `mensagens_bloqueadas: true`
- **Admin** e **supervisor** continuam vendo todas as mensagens (sem bloqueio)
- **Grupos** não sofrem bloqueio — todos continuam vendo mensagens

**Novo campo na resposta:**

| Campo                 | Tipo    | Descrição                                                                 |
|-----------------------|---------|---------------------------------------------------------------------------|
| `mensagens_bloqueadas`| `boolean`| Presente e `true` quando as mensagens foram bloqueadas para este usuário |
| `atendente_nome`      | `string` | Nome do usuário que assumiu a conversa (já existia; usar para a mensagem) |

**Exemplo de resposta quando bloqueado:**

```json
{
  "id": 123,
  "telefone": "5511999999999",
  "contato_nome": "Cliente Exemplo",
  "atendente_nome": "João Silva",
  "mensagens": [],
  "mensagens_bloqueadas": true,
  "next_cursor": null,
  ...
}
```

---

## O que o Frontend deve fazer

### 1. Exibir mensagem informativa

Quando o usuário **clicar** em uma conversa e a API retornar `mensagens_bloqueadas === true`:

- **Não** exibir a lista de mensagens (ela virá vazia)
- **Exibir** uma mensagem centralizada no painel de mensagens, no formato:

  > **Este atendimento foi assumido por [nome do atendente].**

  Use o campo `atendente_nome` da resposta. Se `atendente_nome` for `null` ou vazio, use texto genérico: *"Este atendimento foi assumido por outro usuário."*

**Sugestão de implementação:**

- Componente de estado vazio quando `mensagens_bloqueadas === true`
- Ícone opcional (ex.: usuário com cadeado) para reforçar visualmente
- Texto: `Este atendimento foi assumido por ${conversa.atendente_nome || 'outro usuário'}.`

### 2. Desabilitar ações de envio

- Ocultar ou desabilitar o campo de digitação e botão de enviar mensagem quando `mensagens_bloqueadas === true`
- O backend já retorna 403 ao tentar enviar (quem não assumiu não pode enviar); o frontend pode evitar chamadas desnecessárias desabilitando a UI

### 3. Ignorar eventos socket `nova_mensagem`

- Os eventos `nova_mensagem` continuam sendo emitidos para `empresa_{id}` e `conversa_{id}`
- Quando `mensagens_bloqueadas === true` para a conversa aberta, o handler de `nova_mensagem` **não deve** adicionar a mensagem ao estado/local
- Assim o usuário não verá novas mensagens "vazando" via WebSocket

**Exemplo de lógica no handler:**

```javascript
socket.on('nova_mensagem', (payload) => {
  if (conversaAberta?.mensagens_bloqueadas && payload.conversa_id === conversaAberta.id) {
    return // Não exibir mensagem
  }
  // ... lógica normal de upsert na lista
})
```

### 4. Persistir o flag no estado da conversa

- Ao carregar a conversa via `GET /chats/:id`, armazene `mensagens_bloqueadas` e `atendente_nome` no estado da conversa aberta
- Use esses valores para o item 1 e 3 acima

---

## Resumo da checklist

| # | Tarefa | Arquivo(s) sugerido(s) |
|---|--------|------------------------|
| 1 | Verificar se a resposta de `GET /chats/:id` é usada para popular o painel de mensagens | Service/API de chats, componente de chat |
| 2 | Adicionar condicional: se `mensagens_bloqueadas === true`, exibir mensagem "Este atendimento foi assumido por [atendente_nome]." | Componente do painel de mensagens (lista/chat) |
| 3 | Desabilitar input de envio quando `mensagens_bloqueadas === true` | Componente de input/envio de mensagem |
| 4 | No handler `nova_mensagem`, ignorar quando `mensagens_bloqueadas` para a conversa aberta | Hook/contexto de socket ou componente de chat |
| 5 | Garantir que `mensagens_bloqueadas` e `atendente_nome` sejam armazenados no estado da conversa ao carregar | Store/context/state da conversa aberta |

---

## API afetada

| Endpoint | Método | Alteração na resposta |
|----------|--------|------------------------|
| `/chats/:id` | GET | Novo campo `mensagens_bloqueadas: true` quando bloqueado; `mensagens` vazio; `atendente_nome` já existente |

---

## Resultado esperado

1. Usuário clica em conversa assumida por outro → vê header da conversa (nome, foto etc.) + mensagem centralizada: *"Este atendimento foi assumido por João Silva."*
2. Campo de enviar mensagem desabilitado ou oculto
3. Novas mensagens via socket não aparecem para quem não assumiu
4. Admin e supervisor continuam vendo tudo normalmente
