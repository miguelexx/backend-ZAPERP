# Notificações do HelpDesk

## Preparação do banco

Execute `scripts/adicionar_helpdesk_notificacoes.sql` antes de publicar o backend e o frontend.

## Regras

- `ticket_created`: somente usuários ativos vinculados ao departamento do chamado recebem em tempo real; não cria linhas por usuário.
- A fila compartilhada é a quantidade de chamados `aberto`, sem responsável, nos departamentos do usuário.
- `message_created`: o responsável recebe uma notificação persistente; sem responsável, o departamento recebe somente em tempo real.
- `ticket_transferred`: somente o novo responsável recebe.
- Ações do próprio atendente não geram notificação para ele.
- Abrir um chamado marca como lidas todas as notificações daquele ticket para o usuário autenticado.
- Ao assumir ou colocar em atendimento, as notificações genéricas `ticket_created` são encerradas para todos.
- Ao transferir, as pendências do responsável anterior são encerradas e o novo responsável recebe `ticket_transferred`.
- Ao resolver, todas as notificações ainda pendentes daquele chamado são encerradas para todos os usuários.
- O contador do menu soma a fila compartilhada com as notificações individuais não lidas.

## Rotas internas do ZapERP

Todas exigem o JWT normal do ZapERP.

```http
GET /api/helpdesk/notifications?limit=100
POST /api/helpdesk/notifications/tickets/{ticketId}/read
POST /api/helpdesk/notifications/read-all
```

## Socket.IO

O backend envia `helpdesk:notification` para a sala `usuario_{id}`. O payload contém:

```json
{
  "id": 1,
  "company_id": 1,
  "usuario_id": 7,
  "ticket_id": 123,
  "tipo": "message_created",
  "titulo": "Nova mensagem no chamado #123",
  "mensagem": "Maria respondeu: Erro ao emitir nota",
  "lida": false,
  "criado_em": "2026-08-15T15:30:00.000Z"
}
```

Quando uma ação encerra notificações automaticamente, o backend envia
`helpdesk:notifications_changed` para cada usuário afetado. Isso sincroniza o contador sem exigir F5:

```json
{
  "company_id": 1,
  "usuario_id": 7,
  "ticket_id": 123,
  "notification_ids": [10, 11],
  "updated": 2,
  "reason": "ticket_resolved"
}
```

Quando a fila compartilhada muda, o backend envia `helpdesk:queue_changed` aos
usuários vinculados ao departamento afetado. O frontend consulta novamente o
contador; o evento não cria registros em `helpdesk_notificacoes`.

## Personalização visual

As variantes do toast ficam centralizadas em:

```text
src/helpdesk/HelpDeskGlobalSocketBridge.jsx
```

No objeto `TOAST_BY_TYPE` é possível trocar a variante de cada evento. As cores dessas variantes vêm do Design System em:

```text
src/components/feedback/toast.css
```

O contador do menu é estilizado em:

```text
src/styles/app.css
```
