# Prompt para implementação do frontend CRM (ZapERP)

**Instrução:** Cole o bloco abaixo (a partir de “--- INÍCIO DO PROMPT ---”) em uma nova conversa do Cursor focada **somente no frontend**. Não altere o backend nesta etapa.

---

## --- INÍCIO DO PROMPT ---

### Contexto

Você vai implementar o **módulo CRM no frontend** do **ZapERP**, consumindo **exclusivamente** o backend já existente. O backend expõe o CRM em:

- **Base URL:** `GET/POST/...` relativos a **`/api/crm`** (recomendado) ou **`/crm`** — **mesmas rotas** nos dois prefixos (definido no `app.js` do backend).

- **Autenticação:** todas as rotas CRM (exceto o callback OAuth do Google) exigem header **`Authorization: Bearer <JWT>`** no mesmo padrão do restante do sistema. O JWT já contém **`company_id`** (multi-tenant obrigatório). Não envie `company_id` no body para “trocar empresa”: isso é definido pelo token.

- **Multiempresa:** qualquer dado retornado já está filtrado pela empresa do usuário. O frontend não deve assumir acesso a outras empresas.

- **Sistema legado:** existem módulos já estáveis (WhatsApp, conversas, chatbot, usuários, etc.). **Não refatore nem quebre** rotas, layout global, autenticação ou navegação existentes. O CRM é um **módulo novo** (novas rotas/páginas ou seção dedicada), integrado ao app atual.

- **Rate limit:** o prefixo `/api` aplica limitador global; evite loops de requisições.

- **WebSocket (Socket.IO):** após login, o cliente já entra na room `empresa_{company_id}`. O backend emite eventos CRM:
  - `crm:lead_updated` — payload inclui `lead_id`, `action` (ex.: `create`, `update`, `move`, `nota`, `atividade`, …)
  - `crm:kanban_refresh` — após mover/reordenar; pode incluir `pipeline_id` ou objeto vazio.

  Use-os para **atualizar listas/kanban** sem polling agressivo (invalidar cache local / refetch seletivo).

- **Referência de API no repositório:** `docs/CRM-API.md` e `routes/crmRoutes.js` — **fonte de verdade** para paths.

#### APIs do ZapERP usadas em conjunto com o CRM (não são `/crm`)

- **Tags dos leads:** `tag_ids` em `POST/PATCH /leads` referem IDs da tabela **`tags`** do sistema. Catálogo: **`GET /api/tags`** (ou **`/tags`** — mesmo router). Não existe endpoint CRM separado só para listar tags.
- **Usuários (responsável, filtros):** **`GET /api/usuarios`** (montado em `app.js`) — usar o mesmo contrato que o restante do frontend já utiliza.
- **Conversa vinculada:** quando o lead tiver `conversa_id`, o atalho “abrir conversa” deve usar a **rota de chat já existente** no app (não inventar path novo).

---

### Base de URLs (copiar exatamente)

Prefixo: **`/api/crm`** (ex.: `GET /api/crm/kanban`).

**Ordem importante no router de rotas do frontend:** rotas estáticas antes de dinâmicas (ex.: `/crm/leads/export` antes de `/crm/leads/:id`).

---

### Mapa de endpoints (backend real)

#### Pipelines
| Método | Caminho | Notas |
|--------|---------|--------|
| GET | `/pipelines` | Query: `ativo=true\|false` opcional. `include=stages` ou `inc=stages` — retorna cada pipeline com array `stages`. |
| POST | `/pipelines` | Body: `nome` (obrigatório), `descricao`, `cor`, `ativo`, `ordem`, `padrao`. Primeiro pipeline da empresa pode virar padrão automaticamente no backend. |
| GET | `/pipelines/:id/full` | Pipeline + `stages` ordenados. |
| POST | `/pipelines/:id/clone` | Body opcional: `{ "nome": "..." }`. |
| PATCH | `/pipelines/:id/padrao` | Marca pipeline como **padrão** da empresa (único). |
| GET | `/pipelines/:id` | Detalhe. |
| PUT | `/pipelines/:id` | Atualização; `padrao: true` desmarca outros. |
| DELETE | `/pipelines/:id` | Só se **não** houver leads no pipeline (409 caso contrário). |

#### Stages
| Método | Caminho | Notas |
|--------|---------|--------|
| GET | `/stages` | Query: `pipeline_id`, `ativo`. |
| POST | `/stages` | Body: `pipeline_id`, `nome`, `descricao`, `cor`, `ordem`, `tipo_fechamento` (`null`\|`ganho`\|`perdido`), `exige_motivo_perda`, `ativo`, `inicial` (boolean). Backend: no máximo um estágio **ganho** e um **perdido** por pipeline. |
| PUT | `/stages/:id` | `inicial: true` redefine estágio inicial; `tipo_fechamento` sujeito à regra de unicidade. |
| DELETE | `/stages/:id` | Só se não houver leads (409). |

#### Origens
| Método | Caminho |
|--------|---------|
| GET | `/origens` — `?ativo=` |
| POST | `/origens` — `nome`, `descricao`, `cor`, `ativo` |
| PUT | `/origens/:id` |

#### Lost reasons (catálogo opcional)
| GET | `/lost-reasons` | Pode retornar vazio. |

#### Leads
| Método | Caminho | Notas |
|--------|---------|--------|
| GET | `/leads` | Lista **enriquecida** + paginação. Ver query string abaixo. |
| GET | `/leads/export` | CSV (`;`), BOM UTF-8. Mesmos filtros que `/leads`; query `max` com **default 5000**, limitado entre **1 e 10000**. |
| POST | `/leads/from-conversa/:conversaId` | Body opcional para sobrescrever campos; cria vínculo com conversa/cliente. |
| POST | `/leads/from-cliente/:clienteId` | Idem para cliente. |
| POST | `/leads` | Ver **Payload criar lead** (Zod `createLeadSchema`). |
| GET | `/leads/:id` | Detalhe: inclui `tags`, `notas`, `atividades`, `historico` (movimentações). |
| PATCH | `/leads/:id` | Campos parciais; `tag_ids` substitui tags. |
| POST | `/leads/:id/move` | Ver **Payload mover lead**. |
| POST | `/leads/reorder` | Body: `{ "stage_id": number, "lead_ids": number[] }` — **lista completa** dos IDs do estágio na ordem desejada. |
| GET | `/leads/:id/history` | Histórico de movimentações. |

**Query string `GET /leads` (backend `buildLeadFilters` + paginação):**
- Paginação: `page` (default 1), `page_size` (default 20, máx. 200).
- Ordenação: `sort` ∈ `nome`, `valor_estimado`, `criado_em`, `atualizado_em`, `ultima_interacao_em`, `data_proximo_contato` (valores inválidos caem em `atualizado_em`); `dir` = `asc` \| `desc` (default da coluna de ordenação: `desc`).
- Filtros: `pipeline_id`, `stage_id`, `responsavel_id` (use string `null` ou `none` para **sem responsável**), `status` (`ativo`\|`ganho`\|`perdido`\|`arquivado`), `origem_id`, `prioridade` (`baixa`\|`normal`\|`alta`\|`urgente`), `sem_contato_dias` (número > 0), `proximo_contato_de`, `proximo_contato_ate`, `criado_de`, `criado_ate`, `proximo_vencido` = `true` (leads ativos com `data_proximo_contato` anterior a “agora”), `q` — busca ILIKE em `nome`, `empresa`, `telefone`, `email`.

**Resposta lista (`GET /leads`):** `{ items, page, page_size, total }`. Cada item inclui objetos aninhados conforme backend: `pipeline`, `stage`, `origem`, `cliente`, `conversa`, `responsavel`, `totais: { notas, atividades }`, `proxima_atividade`, `situacao` (status), além dos campos crus do lead.

#### Notas (lead)
| GET | `/leads/:id/notes` |
| POST | `/leads/:id/notes` | Body: `{ "texto": string }` |
| PUT | `/leads/:id/notas/:notaId` | `{ "texto" }` |
| DELETE | `/leads/:id/notas/:notaId` |

#### Atividades
| GET | `/leads/:id/activities` |
| POST | `/leads/:id/activities` | Ver **Payload atividade** |
| PATCH ou PUT | `/activities/:activityId` | Atualização; se `status: "cancelada"`, o backend remove evento Google. |
| PATCH | `/activities/:activityId/status` | Body: `{ "status": "pendente"\|"concluida"\|"cancelada", "sync_google"?: boolean }` |
| DELETE | `/activities/:activityId` | Remove e tenta remover do Google. |

#### Kanban
| GET | `/kanban` | Query: `pipeline_id` opcional. Se omitido, o backend usa pipeline com **`padrao: true` e `ativo`**, senão o **primeiro pipeline ativo**. Resposta: `{ pipeline, columns: [ { stage, total, leads: [ cards ] } ] }`. Cada **card** inclui pelo menos: `id`, `nome`, `empresa`, `telefone`, `email`, `valor_estimado`, `probabilidade`, `prioridade`, `status`, `data_proximo_contato`, `ultima_interacao_em`, `stage_id`, `pipeline_id`, `tags`, `responsavel` — usar estes campos no layout do card (nome, empresa, responsável, última interação, próximo contato, tags, valor). |

#### Agenda
| GET | `/agenda/resumo` | Contadores agregados (pendentes, janela 7 dias, atrasadas, leads próximo contato vencido). |
| GET | `/agenda` | Query: `de` **ou** `from`, `ate` **ou** `to` (obrigatórios ISO); opcionais: `responsavel_id`, `status`, `tipo`, `pipeline_id`, `stage_id`. Resposta estruturada com `periodo`, `filtros`, `por_dia` (objetos por data `YYYY-MM-DD`), `lista` (`atividades`, `proximos_contatos`). |

#### Dashboard
| GET | `/dashboard` | Query: `pipeline_id` (se ausente/ inválido, o backend usa o **primeiro pipeline ativo ordenado por `ordem`, depois `id`** — não é a mesma regra do Kanban). Handler **`getDashboardExtended`**: base (`pipeline_id`, `totais`, `valor_estimado_soma_ativos`, `por_estagio`) + **`valor_ganho_estimado`**, **`taxa_conversao_ganho_vs_perdido`**, **`leads_sem_contato`** (`sem_contato_dias`, **default 7**), **`atividades_pendentes`**. **Recomendação UX:** manter um `pipeline_id` selecionado no estado global do CRM e enviá-lo em Dashboard, Kanban e listas para evitar divergência. |
| GET | `/dashboard/funnel` | `criado_de`/`de`, `criado_ate`/`ate`, `pipeline_id` (default: pipeline padrão da empresa). Resposta: `pipeline_id`, `periodo`, `total_novos`, `novos_no_periodo_por_estagio[]`. |
| GET | `/dashboard/responsaveis` | `pipeline_id` opcional. Ranking de leads **ativos** por responsável (`valor_potencial`, `total_leads`). |
| GET | `/dashboard/origens` | `pipeline_id` opcional. Ranking por origem (`valor_potencial`, `total_leads`). |

#### Google Calendar
| GET | `/google/connect` | Redireciona para OAuth. Com `?json=1` ou `redirect=0` retorna JSON `{ url }` para abrir em nova aba/popup. |
| GET | `/google/callback` | **Público** (sem JWT); usado pelo Google. |
| GET | `/google/status` | `{ connected, email_google, calendar_id, expiry_date }` ou `connected: false`. |
| POST | `/google/disconnect` | |
| GET | `/google/calendars` | Lista calendários (requer conexão). |
| POST | `/google/calendar` | Body: `{ "calendar_id": string }` — calendário padrão para sync. |
| POST | `/google/sync/:leadId` | Sincroniza atividades do lead com o Google. |

**Segurança:** nunca armazenar tokens OAuth no frontend; apenas fluxos e status expostos pelo backend.

---

### Payloads validados no backend (Zod)

**Criar lead — POST `/leads`** (`createLeadSchema`):
- Obrigatório: `nome` (string 1–500).
- Opcionais: `empresa`, `telefone`, `email`, `valor_estimado`, `probabilidade` (0–100), `prioridade` (`baixa`\|`normal`\|`alta`\|`urgente`), `pipeline_id`, `stage_id`, `cliente_id`, `conversa_id`, `responsavel_id` (número ou `null` para sem responsável), `origem_id`, `data_proximo_contato` (string ISO), `observacoes`, `tag_ids` (array de ids), `vincular_cliente_por_telefone` (boolean).

**Mover lead — POST `/leads/:id/move`** (`moveLeadSchema`):
- Obrigatório: `stage_id`.
- Opcionais: `pipeline_id` (troca de pipeline), `ordem`, `motivo`, `motivo_perda`, `perdido_motivo` (para estágio perdido com `exige_motivo_perda`), `bloquear_cruzamento_pipeline` (se `true` e o lead mudar de pipeline → erro 400), `retornar_snapshot` (boolean). Também aceita query `?snapshot=1` no mesmo endpoint.
- Se `retornar_snapshot` ou `snapshot=1`: resposta `{ lead, column_totals }`; caso contrário, resposta **apenas o objeto lead** atualizado (compatibilidade).

**Reordenar — POST `/leads/reorder`:** `{ stage_id, lead_ids }` — `lead_ids` deve listar **todos** os leads da coluna na ordem final.

**Nota — POST `/leads/:id/notes`:** `{ texto }`.

**Atividade — POST `/leads/:id/activities`** (`atividadeSchema`):
- Obrigatório: `tipo` ∈ `ligacao`, `reuniao`, `whatsapp`, `email`, `tarefa`, `nota`, `visita`, `proposta`, `demo`, `outro`; `titulo`.
- Opcionais: `descricao`, `status`, `data_agendada`, `data_fim`, `timezone` (default backend `America/Sao_Paulo`), `participantes: [{ email, nome? }]`, `responsavel_id`, `sync_google` (boolean — cria/atualiza evento no Google se conectado).

---

### Regras de negócio que o frontend deve respeitar (UX)

1. **Estágio terminal “perdido” com motivo:** se o estágio tem `exige_motivo_perda: true`, ao mover para ele o usuário deve informar `motivo_perda` ou `perdido_motivo` (ambos aceitos no body do move).
2. **Kanban:** após drag **entre colunas**, chamar `POST .../move` com `stage_id` e `pipeline_id` se mudou de pipeline. Após reorder **na mesma coluna**, chamar `POST .../reorder` com a ordem completa dos IDs.
3. **Pipeline padrão:** `GET /kanban` sem `pipeline_id` usa o pipeline marcado `padrao` (ou o primeiro ativo).
4. **Erros:** respostas JSON com `{ error: string }` (e opcionalmente `requestId` no handler global do Express). Tratar 400, 401, 404, 409, 500 de forma legível.

5. **Kanban — atualização otimista:** ao soltar o card, pode aplicar o novo estado na UI imediatamente; se `move` ou `reorder` falhar, **reverter** para o estado anterior ou refazer `GET /kanban`. Preferir `retornar_snapshot: true` (ou `?snapshot=1`) no `move` para receber `column_totals` e alinhar contadores sem refetch completo.

---

### Telas / áreas a implementar (escopo UI)

Implementar navegação sob prefixo sugerido **`/crm`** (ou integrar ao menu existente sem quebrar rotas antigas):

1. **CRM / Dashboard** — consome `GET /dashboard`, `GET /dashboard/funnel`, `GET /dashboard/responsaveis`, `GET /dashboard/origens` (filtros por pipeline/período conforme query suportada).
2. **CRM / Kanban** — consome `GET /kanban`, `GET /pipelines`, `GET /origens`, usuários para filtro de responsável (endpoint de usuários **já existente** no sistema: ex. `/api/usuarios` ou equivalente do projeto — reutilizar). Drag-and-drop com persistência via `move` + `reorder`. Opcional: `retornar_snapshot: true` após move para atualizar contadores sem refetch completo.
3. **CRM / Agenda** — `GET /agenda` + `GET /agenda/resumo`; filtros de período, responsável, pipeline, stage, tipo, status; visualização **agrupada por dia** usando `por_dia` e/ou `lista`.
4. **CRM / Leads** — tabela com `GET /leads`, export `GET /leads/export`, abrir detalhe `GET /leads/:id`.
5. **CRM / Pipelines** — CRUD + clone + definir padrão (`PATCH .../padrao`, `include=stages` na listagem).
6. **CRM / Stages** — CRUD filtrado por `pipeline_id`; indicar inicial/ganho/perdido e `exige_motivo_perda`.
7. **CRM / Origens** — CRUD simples.
8. **Detalhe do Lead** — notas, atividades, histórico, tags, vínculos cliente/conversa; ações: criar nota, criar/editar/cancelar/excluir atividade; link para conversa se `conversa_id` existir (rota de chat **já existente** no app).
9. **Modais:** criar/editar lead (campos alinhados ao schema); criar atividade (campos do `atividadeSchema`); mover lead com campos de motivo quando aplicável; conexão Google (fluxo `connect` → callback redireciona para `APP_URL` com query `crm_google=connected` ou erro — apenas feedback UX, sem tokens).

---

### Qualidade de frontend (obrigatório)

- TypeScript com tipos alinhados aos payloads reais (interfaces geradas manualmente ou inferidas dos responses).
- Componentização; estados de **loading**, **erro** e **vazio** em todas as listas.
- **Sem dados mock** para CRM quando o endpoint existir.
- **Desktop-first**, responsivo; visual limpo e profissional (referência visual do usuário: Kanban estilo board moderno).
- Não alterar estilos globais de forma destrutiva; reutilizar design system / tokens do projeto se existirem.
- Reutilizar cliente HTTP / interceptors de auth já usados no frontend.

---

### O que NÃO fazer

- Não criar endpoints fictícios.
- Não enviar `company_id` manual para contornar tenant.
- Não armazenar tokens Google no `localStorage` (o backend gerencia tokens).
- Não modificar o backend nesta tarefa.

---

## --- FIM DO PROMPT ---

*(Fim do texto para colar no Cursor — frontend apenas.)*
