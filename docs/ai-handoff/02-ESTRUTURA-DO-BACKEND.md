# Estrutura do backend

> Análise: 2026-08-23 · branch `master` · commit-base `66e0771d9f61f840524cd4b0645e742df374a77a` + working tree.

| Caminho | Finalidade |
|---|---|
| `index.js`, `app.js` | boot HTTP/Socket e composição Express |
| `config/` | ambiente e clientes externos |
| `routes/`, `controllers/` | endpoints e orquestração |
| `services/` | negócio, integrações, schedulers e storage |
| `services/providers/ultramsg.js` | adapter efetivamente ativo do WhatsApp (fachada; pasta `services/providers/ultramsg/`; [21](21-ULTRAMSG-PROVIDER-MODULARIZACAO.md)) |
| `services/aiDashboardService.js` | assistente IA (`POST /ai/ask`); Sessão A: pasta `services/aiDashboard/` (puros); queries/classify ainda no service. Mapa: [22](22-AI-DASHBOARD-MODULARIZACAO.md) |
| `controllers/chatController.js` + `controllers/chat/` + `services/chat/` | chat HTTP (shim; lista/texto/PIX em sub-controllers). Mapa: [23](23-CHAT-CONTROLLER-MODULARIZACAO.md) |
| `middleware/` | JWT/perfis, webhooks, rate limit e uploads |
| `helpers/`, `validators/` | regras pequenas e validação Zod/manual |
| `repositories/`, `socket/` | chat interno e presença/socket |
| `workers/` | worker persistente do Disparo |
| `supabase/migrations/` | evolução canônica do banco, por timestamp |
| `supabase/prechecks/`, `supabase/production/` | verificações e variantes para índices concorrentes |
| `supabase/scripts_manuais/perigosos/` | scripts destrutivos; nunca executar automaticamente |
| `scripts/` | diagnóstico, certificação e operações manuais; vários podem acessar serviços reais |
| `tests/` | Jest/Supertest com mocks globais e específicos |
| `public/` | páginas HTML auxiliares servidas pelo backend; conteúdo não analisado |
| `uploads/` | storage local; persistência depende de `UPLOADS_DIR` |
| `sync_tga_dashboard/` | artefatos Python/ZIP/logs e arquivos de ambiente; não é chamado pelos scripts Node. Uso atual `NÃO CONFIRMADO` |
| `docs/` | documentação histórica/oficial; deve ser confrontada com código |

Padrão predominante: `*Routes.js`, `*Controller.js`, `*Service.js`, `*Scheduler.js`, helpers por domínio e migrations `YYYYMMDDHHMMSS_descricao.sql`. Há nomenclatura Z-API legada em `webhookZapiController.js`, `empresa_zapi` e aliases, embora o provider confirmado seja UltraMSG.

Novas funcionalidades devem manter rota fina, controller HTTP, regra em service/helper e migration aditiva com teste. Repositórios são padrão consolidado apenas no chat interno; não é obrigatório inventar essa camada em módulos legados.

## Legado, duplicação e artefatos

- `webhookZapiController.js` é pipeline central atual apesar do nome legado. Mapa para fatiar (não executado): [24](24-WEBHOOK-INBOUND-MODULARIZACAO.md).
- `empresa_zapi` foi fonte legada de credenciais; `whatsapp_instances` é o modelo multi-instância. A migration de remoção da tabela legada existe, mas serviços ainda têm fallback/referências; estado real é pendente.
- CRM interno foi criado em migrations e removido por `20260812120000_drop_crm_legacy_module.sql`; backend atual expõe apenas handoff SSO.
- `campanhas`/`campanha_envios`, `planos`, `users`, `grupos`, `comunidades` foram removidos por migrations posteriores; `schema.sql` ainda os lista.
- `docs/_ANTIGOS` e `docs/_OFICIAL` **não existem** neste tree (histórico no git). Pacotes ZIP, caches Python, logs e coverage não são fonte canônica.
- Não foram encontrados Dockerfile, compose ou configuração CI no backend.
