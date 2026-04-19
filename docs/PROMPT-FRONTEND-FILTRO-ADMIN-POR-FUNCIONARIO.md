# Prompt — Filtro administrativo por funcionário (dropdown premium)

**Instrução:** cole o bloco entre `INICIO DO PROMPT` e `FIM DO PROMPT` numa conversa do Cursor focada no frontend.

---

## INICIO DO PROMPT

### Objetivo

Na área de **filtros em pílulas** da lista de conversas (ex.: Todas, Não lidas, Minha fila, Abertas, Em atendimento, Finalizadas), adicionar **apenas para administradores** um controle extra: um **“balão” com seta** (trigger estilo select/popover premium) que, ao clicar, lista **todos os funcionários** (nomes). Ao escolher um funcionário, a lista deve mostrar **todas as conversas atualmente assumidas por essa pessoa**, incluindo as em **em atendimento** e as **finalizadas** (e demais estados em que a conversa ainda tenha `atendente_id` igual a esse usuário).

### Restrições obrigatórias

1. **Não alterar** o layout, comportamento nem o visual das pílulas existentes (Todas, Não lidas, Hoje, Minha fila, etc.). O novo controle é **adição**; nenhuma regressão em seleção de filtro, socket, paginação ou ordenação.
2. **Não inventar endpoints.** Usar apenas o que já existe no backend deste projeto (ver secção “Backend” abaixo).
3. **Visibilidade:** renderizar o controle **somente** quando o utilizador autenticado for **administrador** (`perfil` / role equivalente já usada no frontend).
4. **Um painel aberto por vez:** ao abrir o dropdown de funcionários, fechar outros popovers/menus da mesma zona se existirem.
5. Fechar o painel em: clique fora, `Esc`, troca de rota relevante, ou ao aplicar a seleção (definir política consistente com o resto da UI).

### Comportamento funcional

1. **Carregar nomes dos funcionários** a partir da listagem de utilizadores já existente no projeto (`GET` de usuários da empresa — ver Backend).
2. **Ordenação:** por nome (alfabética), consistente com a lista de utilizadores.
3. **Ao selecionar um funcionário:**
   - Atualizar a listagem de conversas pedindo ao backend conversas filtradas por **`atendente_id`** igual ao **id** desse funcionário.
   - **Não** usar `minha_fila` neste modo (é um fluxo diferente).
   - Para cobrir **em atendimento** e **finalizadas** sem pedidos duplicados: **omitir** `status_atendimento` na query — o backend devolve conversas desse responsável em qualquer estado aplicável; estados “ociosos” ou regras de badge continuam as mesmas no payload.
4. **Estado “Funcionário selecionado”:** deixar claro no UI qual funcionário está ativo (label no trigger ou pill secundária **só para este controle**, sem mexer nas pílulas existentes).
5. **Limpar filtro:** ação explícita (“Todos” / “Limpar” / ícone X no trigger) que remove o filtro por funcionário e **restaura** o comportamento anterior dos filtros normais (pílulas), sem zumbis de estado.
6. **Conflito com pílulas:** definir prioridade clara e documentada no código, por exemplo:
   - Enquanto o filtro admin-por-funcionário estiver ativo, **desativar** ou **ignorar** temporariamente as pílulas de status que conflitem (ou mostrar as pílulas como estão mas com **fetch** baseado só em `atendente_id` — o importante é **não** quebrar a lista nem duplicar pedidos contraditórios). Preferir uma regra única e previsível.

### Requisitos visuais (premium, profissional)

- **Trigger (“balão com seta”):** forma pill/cápsula alinhada à linha dos filtros, altura e raio harmonizados com o tema escuro atual (referência de estilo: fundo tipo `#202c33`, texto claro, borda muito subtil **ou** sem borda com sombra suave).
- **Seta:** ícone ChevronDown (ou similar) à direita, transição curta na rotação ao abrir (ex. 180°).
- **Painel:** “balão” flutuante com cantos arredondados, **sombra de elevação** discreta, borda 1px rgba branco baixíssima opacidade no dark mode, fundo consistente com o painel lateral.
- **Lista:** linhas com hover suave (background levemente mais claro), texto com boa hierarquia; se a lista for longa, **scroll interno** com altura máxima (ex. `max-h` ~40–50vh) e *scrollbar* fina ou estilizada.
- **Micro-interações:** abertura/fecho com opacity + translateY curtos (150–200ms), `ease-out`.
- **Acessibilidade:** botão do trigger com `aria-haspopup="listbox"` ou `"menu"` conforme implementação, `aria-expanded`, foco gerenciável; lista navegável por teclado se o design system já suportar.

### Integração técnica sugerida

- Componente dedicado, ex.: `AdminAtendenteFilter` + hook `useAdminAtendenteFilter` (estado: `selectedUserId`, `panelOpen`).
- Centralizar o fetch de chats no **mesmo service** já usado pela lista, apenas acrescentando query params quando o admin selecionar funcionário.
- Manter compatibilidade com **socket**: ao receber eventos que atualizem conversas, o item deve continuar coerente com o filtro ativo (`atendente_id`).

### Backend real (ZAPERP — não inventar)

Base HTTP (como o resto do app): **`/api`** + `Authorization: Bearer <JWT>`.

| Necessidade | Método | Rota | Notas |
|-------------|--------|------|--------|
| Lista de utilizadores (nomes / ids) | `GET` | `/api/usuarios` | Resposta inclui `id`, `nome`, etc. Filtrar no frontend só utilizadores relevantes se já existir convenção (ex. `ativo`). |
| Conversas assumidas pelo funcionário | `GET` | `/api/chats` | Query: **`atendente_id=<usuarios.id>`** (inteiro positivo; não usar UUID neste parâmetro). **Não** enviar `minha_fila` neste modo. Omitir `status_atendimento` para incluir vários estados num único pedido. Contrato detalhado: `docs/API-CHATS-QUERY.md`. |

**Nota de permissão no backend:** o filtro por `atendente_id` na listagem aplica-se a perfis que **não** são apenas `atendente` (ex.: **admin** e **supervisor** na implementação atual). No UI, cumprir o requisito de **mostrar o controle só a administradores**; não dependas desse endpoint para utilizadores `atendente`.

**Esclarecimento:** conversas **grupo** ou itens sem `atendente_id` não entram no filtro por responsável; isso é coerente com “conversas assumidas por aquele funcionário”.

### Critérios de aceite

- Só **admin** vê o dropdown; outros perfis não veem elemento nem chamadas extras desnecessárias.
- Pílulas existentes permanecem **visual e funcionalmente** como estão para quem não usa o filtro admin.
- Ao escolher funcionário X, a lista reflete **apenas** conversas com aquele `atendente_id` (incluindo em atendimento e finalizadas, conforme dados no servidor).
- Limpar o filtro devolve o comportamento anterior sem erros nem estado inconsistente.
- Visual alinhado ao tema escuro premium (sem aspecto “bootstrap genérico”).

## FIM DO PROMPT
