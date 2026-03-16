# Prompt Frontend — Toggle "Mostrar nome ao cliente"

Implemente nas configurações/perfil do usuário um botão para ativar/desativar a exibição do nome nas mensagens enviadas ao cliente no WhatsApp.

## API

- **GET /api/usuarios/me** — retorna `{ id, nome, email, perfil, departamento_id, mostrar_nome_ao_cliente }`
- **PATCH /api/usuarios/me** — body: `{ mostrar_nome_ao_cliente: true | false }` — retorna `{ id, nome, mostrar_nome_ao_cliente }`

## Implementação

1. Na página de configurações ou perfil do usuário, adicione um toggle/switch.
2. Label: "Mostrar meu nome nas mensagens ao cliente" (ou similar).
3. Ao carregar: GET /usuarios/me → usar `mostrar_nome_ao_cliente` (default true se não vier).
4. Ao alterar: PATCH /usuarios/me com o novo valor.
5. Opcional: exibir mensagem de sucesso ao salvar.

## Nomes dos grupos

O backend agora busca o nome do grupo automaticamente quando uma mensagem chega sem esse dado (UltraMsg). Se grupos ainda aparecerem sem nome, o usuário pode rodar a sincronização de grupos no painel de integrações (POST /integrations/whatsapp/groups/sync).
