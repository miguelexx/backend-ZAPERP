# `GET /api/chats` — parâmetros de filtro (referência)

## `status_atendimento` (coluna `conversas.status_atendimento` no PostgreSQL)

Valores **persistidos** no esquema base (`supabase/schema.sql`, CHECK na tabela `conversas`):

| Valor | Significado |
|--------|-------------|
| `aberta` | Conversa aberta / em fila (pode mapear na lista para `ociosa` — ver abaixo). |
| `em_atendimento` | Assumida e em atendimento. |
| `fechada` | Atendimento encerrado (estado “finalizado” no produto). |

**Não** existe valor canónico `encerrada` no CHECK do schema legível pelo repo — “encerrada” aparece em cópias de UI/comentários e no evento socket `conversa_encerrada`, mas o estado gravado para conversa finalizada é **`fechada`**.

A migração `20260409100000_reset_opcao_invalida_on_finalize.sql` referencia também `finalizada` em triggers; se existirem linhas antigas ou migrações locais com `finalizada`, tratar como sinónimo operacional de encerramento (alinhamento futuro: unificar só para `fechada`).

### Valores **expostos na listagem** JSON (`status_atendimento` no item)

Além dos valores do BD, a API pode devolver na lista:

| Valor | Origem |
|--------|--------|
| `ociosa` | Derivado quando o BD está `aberta` mas não há movimentação que justifique badge “Aberta” (sem mensagens e sem atendente). Ver `statusAtendimentoParaLista` em `chatController.js`. |
| `null` | Grupos (`is_group`): sem estado de atendimento na UI. |

Sempre que precisar do valor **gravado no BD**, usar o campo **`status_atendimento_real`** na resposta (quando existir no payload).

---

## `atendente_id` (query string)

- **Formato:** inteiro positivo = `usuarios.id`. **UUID não é aceite** neste parâmetro (`atendente_id` na conversa referencia `usuarios(id)` inteiro).
- **Quem aplica o filtro:** apenas perfis **`admin`** e **`supervisor`**. Para **`atendente`**, o parâmetro é ignorado na query (mantém-se o comportamento de listagem completa para operação).
- **Sem `minha_fila`:** este modo não usa a regra operacional de “Minha fila”.
- **Sem filtro implícito de status:** se **não** enviar `status_atendimento`, o resultado inclui **todos** os estados da conversa (`aberta`, `em_atendimento`, `fechada`, etc.) desde que `atendente_id` na linha coincida com o parâmetro.
- **Grupos:** com `atendente_id` definido (e perfil admin/supervisor), **grupos não entram** na lista — só conversas individuais não-grupo com esse responsável.
- **Conversas sem responsável:** não aparecem (`atendente_id` na linha tem de igualar ao filtro).
- **`incluir_todos_clientes`:** quando o filtro por `atendente_id` está ativo para admin/supervisor, a expansão “todos os clientes sem conversa” **não** é aplicada (evita poluir a vista administrativa).

Combinações: `status_atendimento` + `atendente_id` aplicam **ambos** (AND): útil para “fechadas do usuário X”, etc.

---

## Verificação na implementação (`listarConversas`)

- O filtro de status só é aplicado quando `statusNorm` está definido (`else if (statusNorm)`).
- Com **apenas** `atendente_id` (e sem `minha_fila`), **não** há ramo que restrinja status — só `company_id`, regras de setor admin, tags/palavra/datas opcionais, `eq(atendente_id)`, exclusão de grupo.
