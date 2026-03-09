# Prompt para implementar a Página de Permissões no Frontend

Copie e cole o texto abaixo ao solicitar a implementação da página de permissões no frontend:

---

## PROMPT

Crie uma **página completa de Permissões** em Configurações para o sistema de atendimento WhatsApp. Siga as especificações abaixo.

### Contexto
- O backend já possui APIs prontas para permissões granulares.
- Cada usuário tem perfil (admin, supervisor, atendente) com permissões padrão.
- O **admin** pode sobrescrever permissões por usuário (conceder ou negar itens específicos).

### APIs do backend (base URL: `/api` ou sem prefixo)

1. **`GET /config/permissoes/catalogo`** — Lista todas as permissões agrupadas por categoria. Requer auth + supervisor/admin.

2. **`GET /usuarios/me/permissoes`** — Retorna as permissões efetivas do usuário logado. Qualquer usuário autenticado. Útil para esconder/mostrar menus.

3. **`GET /usuarios/:id/permissoes`** — Retorna permissões de um usuário específico. Admin ou o próprio usuário.

4. **`PUT /usuarios/:id/permissoes`** — Atualiza overrides de permissões. Somente admin.  
   Body: `{ "permissoes": { "config.ver": true, "config.editar": false, "dashboard.ver": null } }`  
   - `true` = concede, `false` = nega, `null` = remove override (usa padrão do perfil)

### Requisitos da página

1. **Localização:** Em Configurações, como item de menu "Permissões" ou "Usuários e Permissões". Apenas admin ou quem tem `usuarios.permissoes` deve ver/acessar.

2. **Layout sugerido:**
   - Seletor de usuário no topo (dropdown ou lista) para escolher qual usuário editar.
   - Ao selecionar, exibir: nome, email, perfil e setor do usuário.
   - Lista de permissões agrupadas por **categoria** (Clientes, Atendimentos, Configurações, IA/Chatbot, Dashboard, Usuários, Integrações, Tags).

3. **Controles por permissão:**
   - Cada permissão deve ter um switch/toggle com 3 estados visuais:
     - **Concedido** (verde/ativo)
     - **Negado** (vermelho/inativo)
     - **Padrão do perfil** (neutro/cinza) — quando não há override
   - Alternativa: dois botões "Permitir" e "Negar", e opção "Usar padrão" para remover override.
   - Indique visualmente quando há **override** (ex.: badge "Personalizado" ou ícone).

4. **Botões de ação:**
   - **"Restaurar padrão"** — Remove todos os overrides deste usuário (envia `null` para todas que têm override).
   - **"Salvar"** — Envia `PUT /usuarios/:id/permissoes` com o objeto `permissoes` contendo apenas os valores alterados (ou o delta).

5. **Validações:**
   - Só admin pode acessar e editar.
   - Não permitir que o admin remova `usuarios.permissoes` de si mesmo (ou exibir aviso).
   - Feedback de sucesso/erro ao salvar.

6. **Integração com o app:**
   - Ao carregar o app, chamar `GET /usuarios/me/permissoes` e guardar no estado global (Context, Redux, Zustand, etc.).
   - Usar esse mapa para:
     - Esconder itens do menu que o usuário não tem permissão.
     - Desabilitar botões (ex.: "Criar usuário" se não tem `usuarios.criar`).
     - Proteger rotas (redirect para 403 ou página de acesso negado).

7. **Estados de carregamento:**
   - Loading ao buscar catálogo e permissões do usuário.
   - Loading ao salvar.

8. **Responsividade:** A página deve funcionar bem em desktop e mobile.

### Referência do catálogo de permissões

As permissões vêm do backend em `GET /config/permissoes/catalogo`. Cada item tem: `codigo`, `nome`, `descricao`, `categoria`, `perfis`.  
Exemplos de códigos: `clientes.ver`, `clientes.criar`, `atendimentos.ver`, `config.ver`, `config.editar`, `usuarios.permissoes`, etc.

### Documentação adicional

Consulte `docs/PAGINA-PERMISSOES-FRONTEND.md` no backend para detalhes completos das APIs, estrutura de resposta e wireframe.

### Extras desejáveis

- Busca/filtro de permissões por nome ou categoria.
- Indicador de quantas permissões estão em override.
- Tooltip com a descrição de cada permissão.
- Exportar/importar configuração de permissões (opcional).
