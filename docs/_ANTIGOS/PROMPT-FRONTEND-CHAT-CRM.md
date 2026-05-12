# Prompt — Botão « Enviar ao CRM » no chat (ZapERP)

**Instrução:** Cole o bloco entre « INÍCIO » e « FIM » numa conversa do Cursor focada no **frontend** (pasta do app React/Vue/etc.). O backend já está pronto.

---

## INÍCIO DO PROMPT

### Objetivo

Adicionar no **cabeçalho da conversa** (ao lado de Tags, Histórico, Assumir, Transferir) um botão **« Enviar ao CRM »** com visual **premium**: ícone discreto + label clara, estados de loading, feedback de sucesso/erro, acessível (aria-label), coerente com o tema **dark + teal** do ZapERP.

**CRM opcional:** só mostrar o botão se **`crm_habilitado !== false`** (vem em **GET `/api/usuarios/me`**, no **login** em `usuario.crm_habilitado`, ou em **GET `/api/config/empresa`**). Em **Configurações → empresa**, o administrador envia **PUT `/api/config/empresa`** com `{ "crm_habilitado": true | false }`. Se desligado, **não renderizar** o botão (e chamadas a `/api/crm/...` retornam **403** `CRM_DISABLED`).

### API (backend real — não inventar rotas)

- **POST** ` /api/crm/leads/from-conversa/:conversaId `
- **Header:** `Authorization: Bearer <JWT>` (igual ao resto do app).
- **Body:** JSON opcional; todos os campos são opcionais (validação Zod `fromConversaBodySchema` no backend).

**Campos úteis do body (opcionais):**

| Campo | Uso na UI |
|--------|-----------|
| `observacoes` | Texto livre do atendente (é anexado **abaixo** do bloco automático de importação) |
| `pipeline_id`, `stage_id`, `origem_id` | Seletores avançados (default: pipeline/estágio padrão no servidor) |
| `responsavel_id` | Override do responsável (default no servidor: utilizador atual) |
| `tag_ids` | IDs extra (as **tags da conversa** são copiadas automaticamente se `vincular_tags_da_conversa` não for `false`) |
| `vincular_tags_da_conversa` | default `true` — mantém sincronização com tags do chat |
| `criar_nota_com_resumo` | default `true` — cria nota interna com trecho do histórico recente |
| `sincronizar_duplicata` | default `true` — se já existir lead, **atualiza** (200). Se `false` e já existir → **409** |
| `atualizar_responsavel_em_duplicata` | default `false`; com `true` + `responsavel_id` altera responsável no lead existente |

### Respostas HTTP (tratar todas)

| Status | Significado | UX |
|--------|-------------|-----|
| **201** | Lead criado | Toast de sucesso; mostrar atalho « Abrir no CRM » se existir rota `/crm/...` |
| **200** | Lead já existia; servidor **sincronizou** tags/última interação | Toast informativo: « Já estava no CRM — atualizado » |
| **409** | Duplicata e `sincronizar_duplicata: false` | Toast: já existe lead; botão « Abrir lead #… » usando `response.lead.id` |
| **401/404/500** | Erro | Mensagem amigável; não limpar estado do chat |

**Formato JSON de sucesso (201/200):**

```json
{
  "lead": { "...": "detalhe enriquecido com notas, atividades, tags, historico" },
  "from_conversa": {
    "created": true,
    "duplicate": false,
    "conversa_id": 123,
    "tags_sincronizadas": 2,
    "nota_resumo_criada": true,
    "nota_resumo_id": 456
  }
}
```

Em **200** com duplicata: `from_conversa.duplicate: true`, `created: false`.

**409:**

```json
{
  "error": "Já existe um lead vinculado a esta conversa.",
  "lead": { "...": "detalhe completo" },
  "from_conversa": { "duplicate": true, "sincronizado": false, "conversa_id": 123 }
}
```

### WebSocket

Após sucesso (201/200), o backend emite `crm:lead_updated` e `crm:kanban_refresh` na room `empresa_{company_id}`. Se o CRM estiver aberto noutro ecrã, pode invalidar cache — **não é obrigatório** para o primeiro envio desde do chat.

### UX / UI (requisitos)

1. Botão só com **`conversaId`** da rota/contexto atual — desativar se não houver conversa carregada.
2. **Loading** inline (spinner no botão ou estado `disabled` + texto « A enviar… »).
3. **Sucesso 201:** animação curta (ex.: check) + toast com CTA « Abrir no CRM » (deep link ` /crm/leads/:id ` ou equivalente já definido no projeto).
4. **Sucesso 200 (duplicate):** mensagem clara — não parecer erro.
5. **409:** não usar toast vermelho agressivo; tratar como informação + CTA para abrir lead.
6. **Não** armazenar tokens nem dados sensíveis além do que o app já guarda.
7. Opcional: **modal** minimalista antes de enviar — campo único « Nota para o comercial » mapeado para `observacoes` (body), checkbox « Incluir resumo das mensagens na nota » → `criar_nota_com_resumo`.

### O que não fazer

- Não criar endpoints novos no frontend que não existam no backend.
- Não enviar `company_id` manual no body (vem do JWT).
- Não quebrar o layout do header existente (integrar o botão no grupo à direita).

### Ficheiros prováveis a tocar

- Componente do **header da conversa** / toolbar de ações (onde estão Assumir e Transferir).
- Cliente HTTP partilhado (`api`, `axios`, etc.).
- Tipos TypeScript alinhados à resposta real (`lead`, `from_conversa`).

---

## FIM DO PROMPT

---

### Referência de implementação no backend

- `services/crmService.js` → `createLeadFromConversa`
- `validators/crmValidators.js` → `fromConversaBodySchema`
- `docs/CRM-API.md` → secção « POST /leads/from-conversa »
