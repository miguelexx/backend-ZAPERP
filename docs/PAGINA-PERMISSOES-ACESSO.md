# Página de Permissões — Acesso

## URL

Acesse a página de permissões em:

```
/permissoes
```

Exemplo: `https://seu-dominio.com/permissoes`

## Requisitos

- Usuário **autenticado** (token JWT em `localStorage` como `token`, `authToken` ou `jwt`)
- Perfil **admin** (somente admin pode editar permissões de outros usuários)

## Funcionalidades

1. **Seletor de usuário** — escolha o usuário para editar permissões
2. **Informações do usuário** — nome, e-mail, perfil e setor
3. **Permissões por categoria** — Clientes, Atendimentos, Configurações, IA/Chatbot, Dashboard, Usuários, Integrações, Tags
4. **Controles por permissão** — Permitir / Negar / Padrão (usa o padrão do perfil)
5. **Restaurar padrão** — remove todas as personalizações e volta ao padrão do perfil
6. **Salvar** — persiste as alterações

## Integração com o menu

Para incluir no menu lateral da Central de administração, adicione um link para `/permissoes` na seção "Permissões" ou "Usuários".

A rota é servida diretamente pelo backend e consome as APIs em `/api/config/permissoes/catalogo`, `/api/usuarios` e `/api/usuarios/:id/permissoes`.
