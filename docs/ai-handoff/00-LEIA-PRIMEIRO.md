# Leia primeiro — handoff do backend ZapERP

> Análise estática em 2026-08-23, branch `master`, commit-base `66e0771d9f61f840524cd4b0645e742df374a77a`. **Atualizado 2026-08-31:** Etapa 9 de Disparo está **no Git** (não é mais “só working tree”); aplicação no banco/VPS continua `PENDENTE DE VALIDAÇÃO`. Inventário de docs: [`docs/DOCUMENTATION_AUDIT.md`](../DOCUMENTATION_AUDIT.md).

> **Atualização 2026-08-24:** Documentação reorganizada. Ver [`docs/README.md`](../README.md) e [`docs/AI_HANDOFF.md`](../AI_HANDOFF.md). Mudanças pós commit-base registradas na seção abaixo.

> **Atualização 2026-09-01:** Webhook inbound: [24](24-WEBHOOK-INBOUND-MODULARIZACAO.md) (fases 1–4 feitas; fase 5 em andamento). **Não** mover `receberZapi` sem o mapa. Chat = shim (19–23). Mapa DISPARO: [27](27-DISPARO-MAPA.md).

Frontend (UI React): não está nesta série. Use [`frontend/docs/ai-handoff/00-LEIA-PRIMEIRO.md`](../../../frontend/docs/ai-handoff/00-LEIA-PRIMEIRO.md) e o [índice-mestre por sessão](../../../docs/ai-handoff/00-LEIA-PRIMEIRO.md).

## Mudanças pós commit-base (2026-08-24)

As seguintes mudanças ocorreram no working tree e/ou foram commitadas após a análise inicial:

| Mudança | Migration / arquivo | Impacto |
|---------|---------------------|---------|
| Módulo `campanhas` removido | `20260812140000_drop_campanhas_module.sql` | Tabelas `campanhas`, `campanha_envios` dropadas; código em `controllers/campanhaController.js`, `services/campanhaService.js`, `routes/campanhaRoutes.js` removido |
| CRM interno removido | `20260812130000_drop_empresas_crm_habilitado.sql` | `services/crmService.js`, `services/crmGoogleService.js`, `controllers/crmController.js`, `repositories/crmRepository.js`, `helpers/crmEmpresaFlag.js`, `middleware/requireCrmHabilitado.js` removidos; mantido apenas `crmSsoController` (handoff JWT para CRM externo) |
| `empresas_whatsapp` legado removido | `20260812150000_drop_empresas_whatsapp_legacy.sql` | Tabela dropada |
| `planos` removido | `20260812160000_drop_planos.sql` + `20260812170000_drop_empresas_plano_id.sql` | Tabelas dropadas |
| `scheduler_locks` users removido | `20260812130000_drop_scheduler_locks_users.sql` | Tabela dropada |
| Disparo etapas 5–9 adicionadas | `20260821*` a `20260823*` | Tabelas `disparo_*` para limites, revisão, fila, opt-out, respostas, auditoria |
| Busca por prefixo de palavra | `20260823230000_chat_search_word_prefix.sql` | Nova RPC de busca |
| Nomes vinculados (irmãos no mesmo telefone) | `20260827220000_cliente_nomes_vinculados.sql` | Tabela + EXISTS nas RPCs de busca; só importação com switch. Não aplicada automaticamente. |
| R2 storage para mensagens | `20260813120000_mensagens_storage_r2.sql` | Campo `r2_key` em mensagens |

## Objetivo e estado

Backend Node.js/CommonJS para atendimento WhatsApp multiempresa: HTTP Express, Socket.IO, Supabase/PostgreSQL, UltraMSG, mídia local/R2, chatbot, alertas, help desk, produtos e campanhas de disparo. O processo principal é funcional e coberto por Jest; o módulo Disparo está em evolução.

## Estado das modularizações (ler o doc da tarefa)

Não redescobrir pastas: o código já foi fatiado em vários módulos. Fachada no path antigo na maioria dos casos.

| Módulo | Estado **CONFIRMADO** | Doc |
|--------|----------------------|-----|
| Alerta sem resposta | Shim `atendimentoSemRespostaService.js` → pasta `services/atendimentoSemResposta/` | [19](19-ATENDIMENTO-SEM-RESPOSTA-MODULARIZACAO.md) |
| Dashboard HTTP | Shim `dashboardController.js` → `controllers/dashboard/` | [20](20-DASHBOARD-MODULARIZACAO.md) |
| Adapter UltraMSG | Shim `providers/ultramsg.js` → `require('./ultramsg/index.js')` (**não** `./ultramsg`) | [21](21-ULTRAMSG-PROVIDER-MODULARIZACAO.md) |
| Assistente IA `/ai/ask` | **Sessão A feita:** puros em `services/aiDashboard/`. Queries, classify, format e `switch` ainda no service. Próximo = Sessão B | [22](22-AI-DASHBOARD-MODULARIZACAO.md) |
| Chat HTTP | **Shim:** `controllers/chat/` + `services/chat/`. Lista/texto/PIX **já saíram** (`conversationListController`, `textMessageController`, `pixController` — podem estar untracked). Não reextrair | [23](23-CHAT-CONTROLLER-MODULARIZACAO.md) |
| Webhook inbound/ACK | **Parcial.** Helpers + `statusZapi` + saídas antecipadas em `controllers/webhookInbound/` (fases 1–4; fase 5 fatiando o miolo de `receberZapi`). Não mover `receberZapi` sem o mapa | [24](24-WEBHOOK-INBOUND-MODULARIZACAO.md) |

Não confundir [20](20-DASHBOARD-MODULARIZACAO.md) (KPIs HTTP) com [22](22-AI-DASHBOARD-MODULARIZACAO.md) (linguagem natural). Não unificar as quatro APIs de JID do UltraMSG. Não fundir “sem resposta” da IA com o job [19](19-ATENDIMENTO-SEM-RESPOSTA-MODULARIZACAO.md).

`git status` no início da sessão: preservar untracked do chat (`conversationListController`, `textMessageController`, `pixController`) e qualquer outro trabalho não commitado.

## Documentos que **não** mapeiam o código atual

Inventário completo: [`DOCUMENTATION_AUDIT.md`](../DOCUMENTATION_AUDIT.md). Em resumo:

- `docs/_OFICIAL/`, `docs/_ANTIGOS/`, `PATCH-MULTI-TENANT-ENV.md` — **não existem** neste tree.
- `supabase/schema.sql` — fotografia; fonte = migrations.
- Cabeçalhos `2026-08-23` / 100 suites / “Etapa 9 não commitada” — snapshot; confrontar código.

Estados de certeza usados:

- **CONFIRMADO:** observado no código, migration, configuração ou teste.
- **INFERÊNCIA:** consequência técnica direta, sem validação em ambiente real.
- **PENDENTE DE VALIDAÇÃO:** exige banco, UltraMSG ou VPS; nada foi consultado externamente.

## Ordem de leitura

1. [Arquitetura](01-ARQUITETURA.md) e [estrutura](02-ESTRUTURA-DO-BACKEND.md).
2. [Banco](03-BANCO-DE-DADOS.md), [segurança](08-AUTENTICACAO-SEGURANCA-E-MULTITENANCY.md) e [arquivos críticos](16-MAPA-DE-ARQUIVOS-CRITICOS.md).
3. [Módulos](04-MODULOS-E-REGRAS-DE-NEGOCIO.md) e [API](05-API-ENDPOINTS.md).
4. [UltraMSG](06-WHATSAPP-ULTRAMSG-E-WEBHOOKS.md), [Socket.IO](07-SOCKET-IO-E-TEMPO-REAL.md) e [jobs](09-JOBS-CRON-E-PROCESSAMENTOS.md).
5. [configuração](10-CONFIGURACAO-E-AMBIENTES.md), [testes](11-TESTES-E-VALIDACAO.md), [operação](12-DEPLOY-E-OPERACAO.md) e [riscos](13-PROBLEMAS-CONHECIDOS-E-DIVIDA-TECNICA.md).
6. [decisões](14-DECISOES-TECNICAS.md), [glossário](15-GLOSSARIO.md), [checklist](17-CHECKLIST-PARA-PROXIMA-IA.md) e [anti-padrões](18-ANTI-PADROES-E-ARMADILHAS.md).
7. Alerta sem resposta **já fatiado** — invariantes: [19](19-ATENDIMENTO-SEM-RESPOSTA-MODULARIZACAO.md).
8. Dashboard HTTP **já fatiado**: [20](20-DASHBOARD-MODULARIZACAO.md).
9. Adapter UltraMSG **já fatiado** (shim `./ultramsg/index.js`): [21](21-ULTRAMSG-PROVIDER-MODULARIZACAO.md).
10. Assistente IA `/ai/ask`: [22](22-AI-DASHBOARD-MODULARIZACAO.md) — Sessão A feita; Sessão B = queries + classify/format. Não confundir com [20](20-DASHBOARD-MODULARIZACAO.md).
11. Chat HTTP **já é shim**: [23](23-CHAT-CONTROLLER-MODULARIZACAO.md) + [`CHAT_ARQUITETURA_MODULAR.md`](../CHAT_ARQUITETURA_MODULAR.md). Não reextrair lista/texto/PIX.
12. Webhook inbound/ACK: [24](24-WEBHOOK-INBOUND-MODULARIZACAO.md). Fases 1–4 feitas; fase 5 em andamento. **Não** mover `receberZapi`/`statusZapi` sem o mapa. Não renomear o arquivo.

## Pontos que exigem análise antes de alteração

- Toda query com dados de negócio deve derivar `company_id` do JWT/contexto do webhook, nunca de query/body.
- `SUPABASE_SERVICE_ROLE_KEY` ignora RLS; filtros do backend são a barreira primária.
- Mensagem outbound cruza persistência, chamada UltraMSG, webhook/ACK, reconciliação e Socket.IO; mudanças locais podem duplicar envio.
- `whatsapp_instance_id` participa da identidade de conversa/mensagem; manter compatibilidade com linhas legadas nulas.
- Schedulers e presença/dedupe em memória pressupõem um processo; PM2 confirma `instances: 1`.
- Disparo real requer simultaneamente worker ligado, live ligado e dry-run falso. Não habilitar automaticamente.
- Migrations recentes têm prechecks e variantes `CONCURRENTLY`; não escolher/aplicar sem inventário do banco real.
- Mídia em `/uploads`, R2 e retenção possui efeitos irreversíveis.

## Limitações e desenvolvimento em curso

- `supabase/schema.sql` declara-se apenas contextual e não representa o schema final; migrations são a fonte.
- Não há `build_sha` em health check nem outro identificador de versão implantada.
- Não há Docker/CI no backend. O processo confirmado é PM2; referências a outros métodos são `NÃO CONFIRMADO`.
- Redis/adapter Socket.IO não existe. Estado de presença, locks JS, rate limit e dedupe local não é compartilhado.
- Etapa 9 de Disparo está **no repositório** (migration `20260823120000_disparo_etapa9_auditoria.sql`, commit `4d182b9`): health, lease `enviando -> incerta`, contadores. **Aplicação no banco/VPS** é `PENDENTE DE VALIDAÇÃO`.
- `docs/_OFICIAL/` e `docs/_ANTIGOS/` **não existem** neste tree. ADR de nomes: [`reference/ADR-LEGACY-NAMING.md`](../reference/ADR-LEGACY-NAMING.md).
- O estado real das migrations, índices, RLS, webhooks e código na VPS é `PENDENTE DE VALIDAÇÃO`.

## Checklist antes de modificar

- [ ] Ler este documento e os documentos do módulo afetado.
- [ ] Verificar `git status`, branch, commit e mudanças do usuário.
- [ ] Rastrear rota → controller → service/helper/repository → tabela/migration → eventos/testes.
- [ ] Confirmar todos os filtros `company_id` e `whatsapp_instance_id` aplicáveis.
- [ ] Mapear efeitos em persistência, provider, webhook, socket, jobs e reconciliação.
- [ ] Manter integrações mockadas e flags de envio real desligadas.
- [ ] Não executar migrations, scripts manuais/perigosos, deploy, commit ou push sem autorização.
- [ ] Atualizar esta documentação e registrar fatos não confirmados.
