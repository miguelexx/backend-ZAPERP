# Prompt — Menu de ações por conversa (estilo WhatsApp Web)

**Instrução:** cole o bloco entre `INICIO DO PROMPT` e `FIM DO PROMPT` numa conversa do Cursor focada no frontend.

---

## INICIO DO PROMPT

### Objetivo

Implementar um menu de ações por item da lista de conversas, inspirado no WhatsApp Web, com visual discreto, moderno e funcional.

Ao passar o mouse em uma conversa:

- exibir uma seta/ícone discreto no canto direito
- ao clicar, abrir menu suspenso com ações

No mobile:

- adaptar para toque (sem depender de hover)

### Restrições obrigatórias

1. **Não quebrar nada que já funciona** (seleção, abertura de conversa, socket realtime, filtros, paginação, ordenação atual).
2. **Não inventar endpoints**. Usar apenas rotas/métodos já existentes no projeto frontend/backend.
3. Se uma ação não tiver backend pronto, manter item visível com estado controlado (disabled + tooltip) até integração real.
4. Apenas **um menu aberto por vez**.
5. Fechar menu em:
   - clique fora
   - tecla `Esc`
   - troca de conversa
   - mudança de lista (filtro/paginação/realtime removendo item ativo)

### Ações que DEVEM existir no menu

- Silenciar notificações
- Fixar conversa
- Adicionar aos Favoritos
- Limpar conversa
- Apagar conversa

### Ações que NÃO devem existir

- Arquivar conversa
- Marcar como não lida
- Adicionar à lista
- Bloquear

### Requisitos visuais

- Seta aparece somente no hover (desktop), com transição suave (opacity/transform leve).
- Visual limpo, discreto e profissional (estilo WhatsApp Web, adaptado ao tema do sistema).
- Menu com sombra leve, borda sutil, boa legibilidade no tema dark/light.
- Abertura com animação curta e suave.
- Posicionamento inteligente para evitar corte na viewport (flip para cima quando necessário).
- Hover da linha não pode ficar poluído.

### Requisitos de acessibilidade

- Botão da seta focável por teclado.
- `aria-haspopup="menu"` e `aria-expanded`.
- Navegação por teclado entre itens.
- `Esc` fecha menu e devolve foco ao botão origem.

### Arquitetura sugerida (obrigatória)

Criar componentes reutilizáveis e separados:

1. `ConversationActionMenuTrigger` (ícone/seta)
2. `ConversationActionMenu` (dropdown + itens + acessibilidade)
3. `useConversationActionMenu` (estado de menu aberto, ancoragem e fechamento externo)
4. `conversationActionsService` (integração com API já existente)

Evitar duplicação:

- centralizar configuração das ações em array tipado (id, label, icon, visible, disabled, onClick)

### Performance e estado

- A lista pode ter muitos itens: evitar rerender global.
- Usar `React.memo` nos itens da lista, com comparador adequado.
- Estado do menu por `openConversationId` no nível da lista (não em cada item).
- Garantir chave estável por `conversa.id` no `map`.

### Integração funcional das ações

#### 1) Silenciar notificações

- Alternar `silenciado` / `não silenciado`.
- Refletir visualmente no item (ícone discreto de mudo).
- Persistir via endpoint real existente (ou método já implementado no service).

#### 2) Fixar conversa

- Alternar `fixada`.
- Conversas fixadas no topo **sem quebrar a ordenação atual** (manter regra atual dentro de cada grupo: fixadas vs não fixadas).
- Funcionar com atualização realtime.

#### 3) Favoritar conversa

- Alternar `favorita`.
- Mostrar indicador visual discreto (ex.: estrela sutil).
- Persistir via API real.

#### 4) Limpar conversa

- Exigir confirmação antes de executar.
- Limpar mensagens da conversa, sem apagar a conversa.
- Atualizar UI imediatamente após sucesso.

#### 5) Apagar conversa

- Exigir confirmação forte.
- Excluir conversa conforme regra atual do sistema.
- Se conversa aberta for apagada, resetar painel de detalhe com segurança.

### Confirmações (UX)

Usar modal/confirm padronizado já existente no projeto:

- Limpar conversa: confirmação simples.
- Apagar conversa: confirmação forte (texto de risco).

### Permissões

Se o sistema já possuir controle de permissões:

- esconder/desabilitar ações sem permissão
- validar também antes de executar

### Realtime / scroll / paginação / filtros

Garantir compatibilidade com:

- eventos socket (`conversa_atualizada`, `atualizar_conversa`, `nova_conversa`, etc.)
- mudança de filtros/abas
- paginação/infinite scroll

O menu não pode:

- abrir na conversa errada
- ficar preso em item removido
- quebrar clique da linha

### Plano de implementação

1. Mapear componente atual de item da conversa e ponto exato de render da linha.
2. Inserir trigger discreto da seta no canto direito (hover desktop + toque mobile).
3. Criar dropdown reutilizável e acessível.
4. Integrar ações com service central (somente endpoints existentes).
5. Implementar fechamento por clique externo/ESC/troca de contexto.
6. Ajustar ordenação para fixadas sem regressão.
7. Adicionar testes:
   - unitários para hook/menu
   - integração para fluxo de abrir/fechar/ação por conversa correta
8. Validar manualmente com scroll, realtime, troca de filtro e mobile.

### Critérios de aceite

- Menu abre na conversa correta e apenas um por vez.
- Ações funcionam ponta a ponta (quando endpoint existir) e não causam regressão.
- UX suave, discreta e profissional.
- Compatível com teclado e mobile.
- Sem bugs de overlay, clipping, foco ou menu fantasma.

### Backend real (ZAPERP — aplicar migration no Supabase)

Rode no banco a migration `supabase/migrations/20260417180000_conversa_usuario_prefs.sql` (tabela `conversa_usuario_prefs`). Sem ela, `PATCH .../prefs` devolve **503** com mensagem explicando.

Base HTTP (como o resto do app): **`/api/chats`** + `Authorization: Bearer <JWT>`.

| Ação | Método | Rota | Body / notas |
|------|--------|------|----------------|
| Silenciar / fixar / favoritar | `PATCH` | `/api/chats/:id/prefs` | JSON parcial: `silenciada`, `fixada`, `favorita` (boolean). Só envie os campos que mudam. |
| Limpar conversa | `POST` | `/api/chats/:id/limpar-mensagens` | Sem body. Apaga mensagens no CRM; mantém a conversa. Socket: `mensagens_conversa_limpas` + `conversa_atualizada`. |
| Apagar conversa | `DELETE` | `/api/chats/:id` | Sem body. Remove conversa e dependências. Socket: `conversa_apagada` + `atualizar_conversa` com `{ id, removida: true }`. Grupos: **400** neste endpoint. |

**Listagem:** `GET /api/chats` passa a incluir por item (quando a migration existe): `silenciada`, `fixada`, `favorita`, `fixada_em`. Conversas **fixadas** sobem no topo (dentro do resultado já filtrado).

**Realtime prefs (só o utilizador que alterou):** evento `conversa_prefs_atualizada` na room `usuario_{id}` com `{ conversa_id, silenciada, fixada, favorita, fixada_em }`.

Remover do frontend o estado **travado** (`disabled` + «Disponível em breve») para estas ações após integrar as rotas acima.

### Estado vazio + botão Assumir (conversas sem mensagens)

**Objetivo:** Na área principal do chat, quando não houver mensagens, mostrar botão **Assumir** para quem quiser iniciar o atendimento — **sem** tratar essa conversa como “Aberta” na lista (badge/aba).

**Backend já expõe:**

| Campo | Onde | Uso |
|-------|------|-----|
| `sem_mensagens` | `GET /api/chats`, `GET /api/chats/:id` | Preview / empty state |
| `exibir_cta_assumir_sem_mensagens` | idem | Se `true`, renderizar CTA **Assumir** no empty state |
| `status_atendimento` | idem | Valor **de lista**: pode ser `ociosa` (BD ainda `aberta`, mas sem movimentação) |
| `status_atendimento_real` | lista + detalhe | Status gravado no BD (`aberta`, `em_atendimento`, `fechada`) |

**Assumir:** `POST /api/chats/:id/assumir` com JWT (mesmo fluxo das outras conversas).

**Contagem da aba “Abertas”:** Contar só conversas que entram no filtro server-side — usar `status_atendimento === 'aberta'` **na resposta já mapeada** ou `exibir_badge_aberta === true`. **Não** contar como “Abertas” quando `status_atendimento === 'ociosa'` ou quando `exibir_badge_aberta === false`, mesmo que `status_atendimento_real === 'aberta'`.

## FIM DO PROMPT

