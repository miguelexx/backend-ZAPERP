# Base de dados — ZapERP

**Fontes usadas:** migrações em `backend/supabase/migrations/`, alterações em `backend/supabase/scripts_manuais/perigosos/RUN_IN_SUPABASE.sql` (movido para fora da raiz em 2026-06-30 — script manual histórico, não é uma migration), referência `backend/supabase/schema.sql` (o próprio ficheiro avisa que é para contexto e pode não refletir a ordem exata de execução), e uso de `supabase.from(...)` no código.

**Supabase readonly MCP:** tentativa de consulta ao `information_schema` falhou por erro de rede (`ENOTFOUND` no host). Este documento **não** substitui uma validação ao vivo no projeto Supabase quando o MCP estiver disponível.

---

## 1. Princípio multi-tenant

- Quase todas as entidades de negócio carregam **`company_id`** (ou equivalente `company_id` em tabelas bigint/int conforme migração).
- **Regra de ouro:** filtros e inserts devem sempre incluir o tenant correto; o JWT/socket garantem o contexto na API, mas as queries devem reforçar o isolamento.

---

## 2. Núcleo operacional WhatsApp / atendimento

Tabelas referidas explicitamente em `RUN_IN_SUPABASE.sql`, `schema.sql` e fluxos de aplicação:

| Tabela | Papel resumido |
|--------|----------------|
| **empresas** | Tenant; colunas adicionais em migrações (ex.: `zapi_auto_sync_contatos`, `crm_habilitado`) — nomes legados não implicam provider Z-API |
| **usuarios** | Utilizadores do painel; `company_id`, `perfil`, `departamento_id` (legado); relação com **usuario_departamentos** (N:N) |
| **departamentos** | Setores por empresa |
| **clientes** | Contactos WhatsApp; telefone, nome, `company_id`, campos CRM/foto (`RUN_IN_SUPABASE` / migrações) |
| **conversas** | Thread por cliente/grupo; `cliente_id`, `atendente_id`, `status_atendimento`, `departamento_id`, `ultima_atividade`, `tipo`, `nome_grupo`, etc. |
| **mensagens** | Mensagens da conversa; `direcao` in/out, `whatsapp_id`, `status`, `tipo`, mídia (`url`, `nome_arquivo`), `reply_meta`, metadados de grupo/localização (migrações) |
| **mensagens_ocultas** | Ocultar “para mim” por utilizador (`RUN_IN_SUPABASE`) |
| **atendimentos** | Registo de ações (`assumiu`, `transferiu`, `encerrou`, `reabriu`) |
| **historico_atendimentos** | Histórico auxiliar (presente em `schema.sql` e scripts) |
| **tags** / **conversa_tags** / **cliente_tags** | Etiquetas |
| **conversa_unreads** | Contadores por utilizador (schema de referência) |

---

## 3. Configuração WhatsApp (UltraMSG)

| Tabela | Papel |
|--------|--------|
| **empresa_zapi** | Uma linha por empresa: `instance_id`, `instance_token`, `client_token`, `ativo` — usada pelo provider **UltraMSG** (nome histórico da tabela, migração `20260302000000_empresa_zapi.sql`) |
| **empresas_whatsapp** | Limite/contadores multi-tenant (`20250209000000_indices_limite_multitenant.sql`) |
| **zapi_connect_guard** | Guard de conexão (nome legado; migração `20260305000000_zapi_connect_guard.sql`) |

---

## 4. Chatbot, IA e mensagens automáticas

| Tabela | Migração / origem |
|--------|-------------------|
| **ia_config** | `20250207000000_ia_config.sql` |
| **regras_automaticas** | idem |
| **bot_logs** | idem |
| **ai_logs**, **ai_cache** | `20250227000001_ai_tables.sql` |

---

## 5. Proteção operacional, jobs e sync

| Tabela | Ficheiro |
|--------|----------|
| **configuracoes_operacionais** | `20260312000000_protecao_operacional.sql` |
| **jobs** | idem — fila de trabalhos (ex.: sync) |
| **auditoria_eventos** | idem |
| **checkpoints_sync** | idem — progresso de sync progressiva |
| **sync_locks** | idem — evitar sync concorrente |

---

## 6. Webhooks e observabilidade

| Tabela | Ficheiro |
|--------|----------|
| **webhook_logs** | `20260313000000_webhook_logs.sql` |

---

## 7. Opt-in, campanhas, auditoria

| Tabela | Ficheiro |
|--------|----------|
| **contato_opt_in**, **contato_opt_out** | `20260310000000_opt_in_opt_out_campanhas_auditoria.sql` |
| **campanhas**, **campanha_envios** | idem |
| **auditoria_log** | idem (+ uso em `helpers/auditoriaLog.js`) |

---

## 8. Avaliações e preferências

| Tabela | Ficheiro |
|--------|----------|
| **avaliacoes_atendimento** | `20260317000000_mensagem_finalizacao_avaliacoes.sql` |
| **conversa_usuario_prefs** | `20260417180000_conversa_usuario_prefs.sql` |

---

## 9. Chat interno

| Tabela | Ficheiro |
|--------|----------|
| **internal_conversations** | `20260412100000_internal_chat_module.sql` |
| **internal_conversation_participants** | idem |
| **internal_messages** | idem |
| **internal_conversation_reads** | idem |

---

## 10. CRM

Tabelas `crm_*` criadas em `20260416000000_crm_module.sql` e extensões em `20260416200000_crm_operational_enhancements.sql`, incluindo:

`crm_pipelines`, `crm_stages`, `crm_origens`, `crm_leads`, `crm_lead_tags`, `crm_atividades`, `crm_notas`, `crm_stage_movements`, `crm_google_tokens`, `crm_webhook_logs_google`, `crm_lost_reasons`, `crm_config`.

---

## 11. Push e dispositivos

| Tabela | Ficheiro |
|--------|----------|
| **push_subscriptions**, **push_inbound_delivery_log** | `20260423130000_web_push_subscriptions.sql` |
| **push_tokens** | `20260510120000_push_tokens_fcm.sql` |

---

## 12. Utilizadores e departamentos (N:N)

| Tabela | Ficheiro |
|--------|----------|
| **usuario_departamentos** | `20260320000000_usuario_multi_departamentos.sql` |

---

## 13. Permissões e respostas rápidas

- **usuario_permissoes** — referenciada em `helpers/permissoesService.js` (validar criação da tabela no histórico SQL do teu projeto Supabase).
- **respostas_salvas** — `20250206000000_respostas_salvas_sla.sql`.

---

## 14. Relacionamentos (diagrama textual)

```
empresas 1───* usuarios
empresas 1───* departamentos
empresas 1───* clientes
empresas 1───* conversas ───* mensagens
clientes 1───* conversas
usuarios 1───* conversas (atendente_id / usuario_id conforme modelo)
departamentos 1───* conversas
conversas 1───* atendimentos
empresas 1───1 empresa_zapi (UNIQUE company_id)
```

(Detalhes de FK adicionais: ver migrações específicas e `schema.sql`.)

---

## 15. Índices e unicidade importantes

Definidos nas migrações (exemplos verificados):

- **`mensagens`:** índice único parcial `(conversa_id, whatsapp_id)` onde `whatsapp_id` não nulo (`20250213000000_...`); evoluções em `20260305000001_mensagens_company_whatsapp_unique.sql` e `20260508120000_mensagens_status_mensagem_compat.sql`.
- **`conversas`:** índices multi-tenant em `20250209000000_indices_limite_multitenant.sql`.
- **Sugestões adicionais (não aplicadas automaticamente):** ficheiro na pasta pai `../PERFORMANCE-INDICES-SUGERIDOS.sql` — revisar antes de executar em produção.

---

## 16. Fluxo de dados: mensagem

1. Webhook grava/atualiza **`mensagens`** + atualiza **`conversas`** (ex.: `ultima_atividade`).
2. Socket notifica salas conforme controller/serviço.
3. Estados de entrega/leitura: colunas `status` / compatibilidades em migrações recentes de mensagens.

---

## 17. Auth Supabase `users`

- Tabela **`public.users`** em `schema.sql` referencia `auth.users` — contexto Supabase Auth; o painel ZapERP usa principalmente **`usuarios`** com JWT próprio (`JWT_SECRET`).

---

## 18. Limitações desta documentação

- Lista de tabelas **não** pretende ser o dump completo de colunas; para alterações de schema usar migrações + diff no Supabase.
- Quando o MCP readonly estiver operacional, cruzar `information_schema.columns` com este mapa.
