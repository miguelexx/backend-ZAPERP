# Prompt Frontend — Nome do atendente acima da mensagem

Implemente a exibição do nome do atendente acima de cada mensagem enviada pelo sistema (direcao `out`).

**Nota:** O backend já inclui o nome do atendente no conteúdo enviado ao WhatsApp — o cliente recebe "Nome: mensagem" ou "— Nome" nas mídias. O frontend do CRM exibe o nome acima da mensagem para usuários internos.

## Payload disponível

Toda mensagem enviada por atendente já traz do backend:
- `usuario_id` — ID do usuário que enviou
- `usuario_nome` — Nome do atendente
- `enviado_por_usuario` — `true` quando a mensagem foi enviada por atendente interno (não pelo cliente)

## Regras
z
1. **Exibir acima da mensagem**: Quando `enviado_por_usuario === true` e `usuario_nome` existir, exiba o nome em texto pequeno/caption acima do conteúdo da mensagem (antes do texto, mídia etc.).
2. **Compatibilidade**: Se `usuario_nome` for null (mensagens antigas), não quebrar — simplesmente não exibir o rótulo.
3. **Mensagens recebidas** (`direcao === 'in'`): Não exibir — `enviado_por_usuario` será false.
4. **Lista lateral**: O `ultima_mensagem_preview` em `conversa_atualizada` pode trazer `usuario_id` e `usuario_nome` — use para preview opcional (ex: "João: última mensagem").

## Onde vem os dados

- **GET /chats/:id** (detalharChat): `mensagens[]` com `usuario_id`, `usuario_nome`, `enviado_por_usuario`
- **GET /chats** (listarConversas): Última mensagem de cada conversa com os mesmos campos
- **Socket `nova_mensagem`**: Payload inclui `usuario_id`, `usuario_nome`, `enviado_por_usuario`
