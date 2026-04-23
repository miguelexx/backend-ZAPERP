# API CRM (ZapERP backend)

Todas as rotas exigem `Authorization: Bearer <JWT>` com `company_id` válido, exceto o callback OAuth do Google.

Base URL: **`/api/crm`** (ou **`/crm`** — mesmo conjunto de rotas).

## Migrações

1. `supabase/migrations/20260416000000_crm_module.sql` — núcleo CRM  
2. `supabase/migrations/20260416200000_crm_operational_enhancements.sql` — `padrao` em pipeline, `inicial` em stage, campos de atividade (fim, participantes, timezone, link Google)
3. `supabase/migrations/20260422120000_empresas_crm_habilitado.sql` — flag `empresas.crm_habilitado` (admin desliga o módulo na empresa)

## Ativação por empresa

- Coluna **`empresas.crm_habilitado`** (`boolean`, default `true`). Se `false`, todas as rotas autenticadas em `/crm` respondem **403** com `{ "error": "...", "code": "CRM_DISABLED" }`.
- Configurações: **PUT `/api/config/empresa`** com `{ "crm_habilitado": false }` (supervisor/admin).
- O frontend pode ler **`crm_habilitado`** em **GET `/api/usuarios/me`** ou no objeto **`usuario`** do login, além de **GET `/api/config/empresa`** (mesmo campo na linha da empresa).

## Pipelines

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/pipelines` | Lista (`?ativo=`, `?include=stages` inclui estágios ordenados) |
| POST | `/pipelines` | Cria (`padrao` opcional; primeiro pipeline vira padrão automaticamente) |
| GET | `/pipelines/:id/full` | Pipeline + `stages` |
| POST | `/pipelines/:id/clone` | Clona estágios (`nome` opcional no body) |
| PATCH | `/pipelines/:id/padrao` | Define como pipeline padrão da empresa |
| GET | `/pipelines/:id` | Detalhe |
| PUT | `/pipelines/:id` | Atualiza (`padrao: true` desmarca os demais) |
| DELETE | `/pipelines/:id` | Exclui se não houver leads |

## Estágios

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/stages` | Lista (`?pipeline_id=&ativo=`) |
| POST | `/stages` | Cria (`inicial: true` marca estágio de entrada; no máx. um **ganho** e um **perdido** por pipeline) |
| PUT | `/stages/:id` | Atualiza (`inicial: true` redefine o estágio inicial) |
| DELETE | `/stages/:id` | Exclui se não houver leads |

## Origens

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/origens` | Lista |
| POST | `/origens` | Cria |
| PUT | `/origens/:id` | Atualiza |

## Leads

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/leads` | Lista enriquecida: pipeline, stage, origem, cliente, conversa, totais, próxima atividade, responsável |
| GET | `/leads/export` | CSV (`;`), mesmos filtros que `/leads`, `?max=` (máx. 10000) |
| POST | `/leads/from-conversa/:conversaId` | **Importação inteligente** do atendimento → CRM (ver abaixo) |
| POST | `/leads/from-cliente/:clienteId` | Cria lead a partir do cliente |
| POST | `/leads` | Cria lead |
| GET | `/leads/:id` | Detalhe completo (notas, atividades, `historico` de movimentações) |
| PATCH | `/leads/:id` | Atualiza |
| POST | `/leads/:id/move` | Move no Kanban. Body: `stage_id`, `pipeline_id?`, `ordem?`, `motivo_perda?`, `bloquear_cruzamento_pipeline?`, `retornar_snapshot?`. Com `retornar_snapshot: true` ou `?snapshot=1` → `{ lead, column_totals }` |
| POST | `/leads/reorder` | Reordena (`stage_id`, `lead_ids[]`) |
| GET | `/leads/:id/history` | Movimentações |

### `POST /leads/from-conversa/:conversaId` — enviar conversa ao CRM

Preenche o lead com dados da **conversa**, **cliente** (se houver), **setor** (`departamentos`), **tags da conversa** (`conversa_tags` → `crm_lead_tags`), **e-mail** do cliente, nome (cliente → `nome_contato_cache` → grupo → telefone), e grava **observações** com bloco estruturado (ticket, setor, status, quem enviou ao CRM).

Opcionalmente cria uma **nota interna** com resumo das últimas mensagens (`criar_nota_com_resumo`, default `true`).

**Resposta (sempre JSON):**

| HTTP | Situação |
|------|----------|
| **201** | Lead **criado**. Corpo: `{ lead, from_conversa: { created: true, duplicate: false, conversa_id, tags_sincronizadas, nota_resumo_criada, nota_resumo_id } }` |
| **200** | Já existia lead para esta conversa e **`sincronizar_duplicata`** não foi `false`: atualiza última interação, **mescla tags** (se `vincular_tags_da_conversa`), retorna `{ lead, from_conversa: { duplicate: true, created: false, ... } }` |
| **409** | Já existe lead e body tem **`sincronizar_duplicata: false`**: `{ error, lead, from_conversa: { duplicate: true, sincronizado: false } }` |

**Body (todos opcionais, validados por Zod `fromConversaBodySchema`):**  
`nome`, `empresa`, `telefone`, `email`, `pipeline_id`, `stage_id`, `origem_id`, `responsavel_id`, `tag_ids` (extras além das da conversa), `prioridade`, `valor_estimado`, `probabilidade`, `observacoes` (texto livre **abaixo** do bloco automático),  
`vincular_tags_da_conversa` (default `true`), `criar_nota_com_resumo` (default `true`),  
`sincronizar_duplicata` (default `true` — se `false` e já existir lead → **409**),  
`atualizar_responsavel_em_duplicata` (default `false`; com `true` + `responsavel_id` atualiza no lead existente).

### Query `GET /leads`

Inclui `proximo_vencido=true` (leads **ativos** com `data_proximo_contato` no passado).

## Atividades

| Método | Rota | Descrição |
|--------|------|-----------|
| GET/POST | `/leads/:id/activities` | Lista / cria (`data_fim`, `timezone`, `participantes[]`, `sync_google`) |
| PATCH/PUT | `/activities/:activityId` | Atualiza; `status: cancelada` remove evento Google |
| PATCH | `/activities/:activityId/status` | Body `{ status, sync_google? }` |
| DELETE | `/activities/:activityId` | Exclui e remove do Google se houver `google_event_id` |

## Agenda

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/agenda` | Objeto com `por_dia` (atividades e próximos contatos), `lista`, filtros `pipeline_id`, `stage_id`, `tipo`, `de`/`ate`, etc. |
| GET | `/agenda/resumo` | Contadores (pendentes, atrasadas, próximos 7 dias, leads com próximo contato vencido) |

## Dashboard

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/dashboard` | Métricas estendidas (valor ganho, taxa conversão, sem contato, atividades pendentes, …) |
| GET | `/dashboard/funnel` | Novos leads no período por estágio (`criado_de`, `criado_ate`, `pipeline_id`) |
| GET | `/dashboard/responsaveis` | Ranking por responsável |
| GET | `/dashboard/origens` | Ranking por origem |

## Kanban

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/kanban` | Usa pipeline **padrão** se `pipeline_id` omitido |

## Google Calendar

Eventos usam `dateTime` + `timeZone` (padrão `America/Sao_Paulo`). Descrição inclui observações do lead e referências internas. Tokens renovados com `refresh_token`; falhas em `crm_webhook_logs_google`.

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/google/connect` | OAuth (`?json=1` → `{ url }`) |
| GET | `/google/callback` | Callback |
| GET | `/google/status` | Status |
| POST | `/google/disconnect` | Desconecta |
| GET | `/google/calendars` | Lista calendários |
| POST | `/google/calendar` | `{ calendar_id }` |
| POST | `/google/sync/:leadId` | Sync em lote das atividades do lead |

## WebSocket

`crm:lead_updated`, `crm:kanban_refresh` na room `empresa_{company_id}`.
