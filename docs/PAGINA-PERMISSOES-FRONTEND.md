# Página de Permissões — Especificação Frontend

## Visão geral

O backend expõe APIs para um sistema de permissões granulares. Cada usuário tem um **perfil** (admin, supervisor, atendente) que define permissões padrão. O admin pode **sobrescrever** permissões por usuário, concedendo ou negando itens específicos.

---

## APIs disponíveis

### 1. Catálogo de permissões
```
GET /config/permissoes/catalogo
GET /api/config/permissoes/catalogo
```
**Auth:** supervisor ou admin

**Resposta:**
```json
{
  "catalogo": [
    {
      "categoria": "Clientes",
      "permissoes": [
        {
          "codigo": "clientes.ver",
          "nome": "Ver clientes",
          "descricao": "Acessar lista e detalhes de clientes",
          "categoria": "Clientes",
          "perfis": ["admin", "supervisor", "atendente"]
        }
      ]
    }
  ],
  "flat": [ /* array plano de todas as permissões */ ]
}
```

### 2. Minhas permissões (usuário logado)
```
GET /usuarios/me/permissoes
GET /api/usuarios/me/permissoes
```
**Auth:** qualquer usuário autenticado

**Resposta:**
```json
{
  "permissoes": {
    "clientes.ver": true,
    "clientes.criar": true,
    "config.ver": false
  },
  "detalhado": [
    {
      "codigo": "clientes.ver",
      "nome": "Ver clientes",
      "descricao": "Acessar lista e detalhes de clientes",
      "categoria": "Clientes",
      "concedido": true,
      "isOverride": false
    }
  ]
}
```

### 3. Permissões de um usuário (admin)
```
GET /usuarios/:id/permissoes
GET /api/usuarios/:id/permissoes
```
**Auth:** admin OU o próprio usuário (apenas leitura)

**Resposta:**
```json
{
  "usuario": {
    "id": 5,
    "nome": "João Silva",
    "email": "joao@empresa.com",
    "perfil": "atendente",
    "departamento_id": 2
  },
  "permissoes": [
    {
      "codigo": "clientes.ver",
      "nome": "Ver clientes",
      "descricao": "Acessar lista e detalhes de clientes",
      "categoria": "Clientes",
      "concedido": true,
      "isOverride": false
    },
    {
      "codigo": "config.ver",
      "nome": "Ver configurações",
      "descricao": "Acessar painel de configurações",
      "categoria": "Configurações",
      "concedido": true,
      "isOverride": true
    }
  ]
}
```

### 4. Atualizar permissões de um usuário (admin)
```
PUT /usuarios/:id/permissoes
PUT /api/usuarios/:id/permissoes
```
**Auth:** somente admin

**Body:**
```json
{
  "permissoes": {
    "config.ver": true,
    "config.editar": false,
    "dashboard.ver": null
  }
}
```
- `true`: concede (override)
- `false`: nega (override)
- `null` ou omitir: remove override (usa padrão do perfil)

**Resposta:**
```json
{
  "ok": true,
  "permissoes": [ /* array de permissões efetivas atualizadas */ ]
}
```

---

## Catálogo completo de permissões

| Código | Nome | Categoria |
|--------|------|-----------|
| clientes.ver | Ver clientes | Clientes |
| clientes.criar | Criar cliente | Clientes |
| clientes.editar | Editar cliente | Clientes |
| clientes.excluir | Excluir cliente | Clientes |
| atendimentos.ver | Ver atendimentos | Atendimentos |
| atendimentos.assumir | Assumir conversa | Atendimentos |
| atendimentos.enviar | Enviar mensagens | Atendimentos |
| atendimentos.encerrar | Encerrar conversa | Atendimentos |
| atendimentos.transferir | Transferir conversa | Atendimentos |
| atendimentos.transferir_setor | Transferir setor | Atendimentos |
| atendimentos.puxar_fila | Puxar da fila | Atendimentos |
| atendimentos.tags | Gerenciar tags em conversas | Atendimentos |
| atendimentos.merge | Mesclar duplicatas | Atendimentos |
| config.ver | Ver configurações | Configurações |
| config.editar | Editar configurações | Configurações |
| config.whatsapp | Configurar WhatsApp | Configurações |
| config.auditoria | Auditoria | Configurações |
| ia.ver | Ver IA/Chatbot | IA/Chatbot |
| ia.editar | Editar IA/Chatbot | IA/Chatbot |
| ia.regras | Regras de triagem | IA/Chatbot |
| dashboard.ver | Ver dashboard | Dashboard |
| dashboard.departamentos_ver | Ver setores | Dashboard |
| dashboard.departamentos_gerenciar | Gerenciar setores | Dashboard |
| dashboard.sla | Configurar SLA | Dashboard |
| dashboard.respostas_salvas | Respostas salvas | Dashboard |
| usuarios.ver | Ver usuários | Usuários |
| usuarios.criar | Criar usuário | Usuários |
| usuarios.editar | Editar usuário | Usuários |
| usuarios.excluir | Excluir usuário | Usuários |
| usuarios.permissoes | Gerenciar permissões | Usuários |
| integracoes.ver | Ver integrações | Integrações |
| integracoes.editar | Editar integrações | Integrações |
| tags.ver | Ver tags | Tags |
| tags.gerenciar | Gerenciar tags | Tags |

---

## Regras de visibilidade (conversas por setor)

**Implementado no backend:** conversas **sem setor** são visíveis **apenas** para usuários **sem setor**. Usuários com setor veem apenas conversas do seu setor + grupos.

- Usuário com setor → vê conversas do seu setor + grupos
- Usuário sem setor → vê conversas sem setor + grupos
- Admin → vê todas

---

## Wireframe sugerido para a página de Permissões

```
┌─────────────────────────────────────────────────────────────────────┐
│  Configurações  ›  Permissões                                       │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Selecione um usuário para editar permissões:                        │
│  ┌───────────────────────────────────────────────────────────────┐   │
│  │ [Dropdown ou lista] João (atendente), Maria (supervisor)...   │   │
│  └───────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  Usuário: João Silva │ joao@empresa.com │ Atendente │ Setor: Vendas  │
│                                                                     │
│  ┌─ CLIENTES ─────────────────────────────────────────────────────┐ │
│  │ [✓] Ver clientes    [✓] Criar    [✓] Editar    [✗] Excluir     │ │
│  └────────────────────────────────────────────────────────────────┘ │
│  ┌─ ATENDIMENTOS ─────────────────────────────────────────────────┐ │
│  │ [✓] Ver atendimentos [✓] Assumir [✓] Enviar [✓] Encerrar...    │ │
│  └────────────────────────────────────────────────────────────────┘ │
│  ┌─ CONFIGURAÇÕES ────────────────────────────────────────────────┐ │
│  │ [✓] Ver config (override) [✗] Editar (override)                │ │
│  │     Override: indica que difere do padrão do perfil             │ │
│  └────────────────────────────────────────────────────────────────┘ │
│  ...                                                                │
│                                                                     │
│  [ Usar padrão do perfil ]  [ Salvar alterações ]                    │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Lógica de exibição de controles

1. **Checkbox por permissão:** Permitir / Negar / Padrão (nenhum override)
2. **Indicador visual para override:** quando `isOverride: true`, destacar (ex.: cor diferente, ícone)
3. **"Usar padrão do perfil":** envia `null` para todas as permissões que estão em override, limpando os overrides
4. **Desabilitar para admin:** admin tem todas; opcionalmente esconder a página ou mostrar só leitura
5. **Não permitir editar a si próprio:** admin não deve remover suas próprias permissões críticas (opcional no frontend)

---

## Uso no App (menus e rotas)

- Ao carregar o app, chamar `GET /usuarios/me/permissoes` e guardar no estado (Context/Redux/Zustand).
- Usar o mapa `permissoes` para esconder ou desabilitar:
  - Itens do menu lateral
  - Botões (ex.: "Criar usuário" se não tem `usuarios.criar`)
  - Rotas (redirect para 403 ou página de acesso negado se a rota exigir permissão que o usuário não tem)

---

## Erros comuns

- **403** ao editar permissões: só admin pode.
- **404** ao buscar usuário: usuário não existe ou é de outra empresa.
- **400** no PUT: body deve ser `{ permissoes: { codigo: boolean|null } }`.
