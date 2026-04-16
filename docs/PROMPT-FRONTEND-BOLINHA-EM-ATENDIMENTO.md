# Prompt — Bolinha verde discreta em conversa "Em atendimento"

**Instrução:** cole o bloco entre `INICIO DO PROMPT` e `FIM DO PROMPT` no Cursor do frontend.

---

## INICIO DO PROMPT

### Objetivo

Quando uma conversa estiver em `Em atendimento` e o cliente enviar nova mensagem, exibir uma **bolinha verde discreta** na lista lateral de conversas para indicar que existe nova mensagem pendente naquela conversa em atendimento.

### Origem dos dados (backend pronto)

O backend agora envia uma flag especifica:

- `tem_novas_mensagens_em_atendimento: boolean`

Ela vem em:

1. **Lista de conversas** (`listarConversas`)
2. **Socket realtime** no evento `conversa_atualizada`

Campos relacionados que ja existem:

- `status_atendimento`
- `tem_novas_mensagens`
- `lida`
- `unread_count`

### Regra de exibicao

Exibir a bolinha verde somente quando:

- `status_atendimento === 'em_atendimento'`
- `tem_novas_mensagens_em_atendimento === true`
- `atendente_id === usuario_logado.id`

Nao exibir para:

- conversas `aberta` ou `fechada`
- grupos
- conversa atualmente aberta (opcional, se o app ja considerar "lida" ao abrir)

### UX visual (discreta)

- Bolinha circular pequena (6px a 8px)
- Cor verde suave (ex.: `#22c55e` com opacidade 0.9)
- Sem texto ao lado
- Posicao sugerida: canto direito do item da conversa, alinhada com o nome/preview
- Com `title`/tooltip: `Nova mensagem no atendimento`

### Acessibilidade

- `aria-label="Nova mensagem no atendimento"`
- Nao depender so de cor para usuarios com acessibilidade reduzida:
  - adicionar `title`
  - opcional: borda fina clara para contraste em tema escuro

### Comportamento em tempo real

No handler de `conversa_atualizada`:

- atualizar estado da conversa com os campos recebidos
- se `tem_novas_mensagens_em_atendimento` vier `true` **e** `atendente_id` for o usuario logado, acender bolinha
- quando conversa for marcada como lida/refetch retornar `false`, remover bolinha

### Nao fazer

- Nao criar endpoint novo
- Nao criar logica paralela baseada em horario/localStorage
- Nao transformar em alerta chamativo (sem animacao agressiva)

### Checklist rapido

1. Entrar em uma conversa e colocar em `Em atendimento`
2. Receber nova mensagem do cliente
3. Ver bolinha verde discreta no item da conversa
4. Abrir a conversa e marcar lida
5. Confirmar que bolinha some

## FIM DO PROMPT

