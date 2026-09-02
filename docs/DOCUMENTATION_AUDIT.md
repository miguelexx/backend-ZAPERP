# Auditoria de documentação — backend ZapERP

> Atualizado **2026-09-01**. Código e migrations prevalecem. Este arquivo é o inventário do que vale, do que foi apagado e do que **não procurar**.

---

## Canônico (usar estes)

| Papel | Onde |
|-------|------|
| Índice | [`docs/README.md`](README.md) |
| Handoff compacto | [`docs/AI_HANDOFF.md`](AI_HANDOFF.md) + [`ai-handoff/00-LEIA-PRIMEIRO.md`](ai-handoff/00-LEIA-PRIMEIRO.md) |
| Série técnica | `docs/ai-handoff/01`–`18` (domínio); **19–24** = mapas de modularização; **25** = ranking de alvos; **26** = auditoria de legibilidade de código; **27** = mapa de código do DISPARO |
| Chat HTTP | [23](ai-handoff/23-CHAT-CONTROLLER-MODULARIZACAO.md) + [`CHAT_ARQUITETURA_MODULAR.md`](CHAT_ARQUITETURA_MODULAR.md) |
| Webhook inbound/ACK | [24](ai-handoff/24-WEBHOOK-INBOUND-MODULARIZACAO.md) (fases 1–4 em `webhookInbound/`; fase 5 em andamento — saídas antecipadas extraídas, miolo do `receberZapi` ainda no arquivo) |
| Nomes `zapi` | [`reference/ADR-LEGACY-NAMING.md`](reference/ADR-LEGACY-NAMING.md) |
| Disparo — **código** (worker/fila/send/gates/tabelas) | [27](ai-handoff/27-DISPARO-MAPA.md) |
| Disparo (produto/runbook) | `../docs/DISPARO_MENSAGENS.md`, `DISPARO_GO_LIVE_RUNBOOK.md`, `DISPARO_MIGRATIONS_RUNBOOK.md`, `DISPARO_PILOTO_PLAN.md`, `DISPARO_CARGA_E_FALHAS.md`, `ATUALIZAR-NA-VPS.md` |
| Índice-mestre front+back | `../docs/ai-handoff/00-LEIA-PRIMEIRO.md` |

`supabase/schema.sql` é fotografia. Fonte = `supabase/migrations/`.

---

## Removido em 2026-09-01 (obsoleto / enganoso / dump)

Não recriar. Histórico continua no Git se precisar.

### Neste repo (`backend/`)

| Item | Motivo |
|------|--------|
| `docs/CHAT_CONTROLLER_MODULARIZACAO.md` | Plano do monolito ~10k linhas **antes** da quebra. Linhas/contagens enganam. Mapa atual = 23 + `CHAT_ARQUITETURA_MODULAR.md`. |
| `scripts/test-webhook-zapi.ps1` | POST em `/webhooks/zapi` (rota inexistente). Runtime = `POST /webhooks/ultramsg`. |

### Repo pai (`whatsapp-plataforma/`)

| Item | Motivo |
|------|--------|
| `ANALISE_PRE_INTEGRACAO_ZAPI.md`, `CONFIGURACAO_WEBHOOKS_ZAPI.md` | Tratam Z-API como provider ativo (`/webhooks/zapi`, `services/providers/zapi.js`). |
| `ANALISE_PRE_INTEGRACAO_WHATSAPP.md`, `REVISAO_COMPLETA_PRE_WHATSAPP.md` | Snapshot Meta / `empresas_whatsapp` (Fev/2025). |
| `REVISAO_ROTAS_FUNCOES.md`, `REVISAO_TECNICA_CRM.md` | Revisões pontuais defasadas; CRM interno dropado. |
| `docs/PROMPT-FRONT-CLIENTES-APAGAR-TODOS.md` | Brief já implementado (`DELETE /clientes/todos` + UI). |
| `docs/RELATORIO-AUDITORIA-PRODUCAO-ZAPERP-2026-07-05.md` | Auditoria pontual; correções já no código. |
| `docs/RELATORIO-CERTIFICACAO-ATENDIMENTO-2026-06-01.md` | Certificação pontual. |
| `docs/AUDITORIA_LIMPEZA_PROJETO.md` | Inventário de disco 23/08; apontava `_OFICIAL` como canônico. |
| `docs/db-audit/` (`analysis.json` ~5 MB + pareceres) | Dump de jun/2026; parecer ainda lista `campanhas`/`crmService` como MANTER. |
| `docs/DISPARO_DEPENDENCIAS.md` | Snapshot `npm audit` de 23/08; versões/CVEs envelhecem. |
| `docs/auditoria-escala-zaperp/RELATORIO-AUDITORIA-ESCALA-ZAPERP-2026-07-03.md` | Achados de 03/07; `chatController` como outbound monolito. SQL de diagnóstico **mantido**. |
| `frontend/docs/ESPECIFICACAO_CHATBOT_TRIAGEM.md` | Mar/2025: “usa apenas Z-API” e webhook `/webhooks/zapi`. |
| `frontend/docs/OTIMIZACAO_FRONTEND_SESSAO_01.md` | Diário de uma sessão já concluída. |

Pastas `docs/_OFICIAL/` e `docs/_ANTIGOS/` **já não existiam** neste tree (removidas antes; ADR vive em `reference/`). `PATCH-MULTI-TENANT-ENV.md` idem.

---

## Mantido de propósito (não é lixo)

- Série `ai-handoff/01`–`18` — domínio ainda válido; cabeçalhos `2026-08-23` / Jest “100/1015” são **snapshot**, não baseline atual.
- Docs **19–25** — mapas e ranking atuais.
- `docs/reference/*` — APIs, flags, scripts, chatbot, help desk, proteção (desativada).
- `public/README.md` — explica HTML estático servido pelo Express.
- Repo pai: `DISPARO_MENSAGENS.md`, `DISPARO_GO_LIVE_RUNBOOK.md`, `DISPARO_MIGRATIONS_RUNBOOK.md`, `DISPARO_PILOTO_PLAN.md`, `DISPARO_CARGA_E_FALHAS.md`, `ATUALIZAR-NA-VPS.md`.
- `docs/auditoria-escala-zaperp/sql/diagnostico_seguro_escala.sql` — SELECT de diagnóstico. Scripts de carga: `tools/load/`.
- Frontend: série `frontend/docs/ai-handoff/` + `AUDITORIA_FRONTEND.md` + `OTIMIZACAO_FRONTEND_IA.md` + `PAGINA-PERMISSOES-FRONTEND.md`.

---

## Não procurar

| Item | Realidade |
|------|-----------|
| `docs/_OFICIAL/`, `docs/_ANTIGOS/` | Ausentes. ADR: `docs/reference/ADR-LEGACY-NAMING.md`. |
| `campanhaController` / `crmService` / `FEATURE_CAMPANHAS` | Removidos. Disparo + SSO CRM. |
| Provider Z-API / rota `/webhooks/zapi` | Não existe. Handler ativo: `webhookZapiController.js` (nome legado) via `POST /webhooks/ultramsg`. |
| `CHAT_CONTROLLER_MODULARIZACAO.md` na raiz de `docs/` | Apagado. Use 23 + `CHAT_ARQUITETURA_MODULAR.md`. |

Comentários JS que citavam `_OFICIAL/ADR-LEGACY-NAMING.md` apontam agora para `docs/reference/ADR-LEGACY-NAMING.md`.
