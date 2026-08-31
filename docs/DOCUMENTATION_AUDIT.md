# Auditoria de documentação — backend ZapERP

> Criado em **2026-08-24** pela tarefa de reorganização completa da pasta `backend/docs/`.  
> Registra o que foi criado, atualizado, removido ou preservado e o motivo.

---

## Atualização 2026-08-31 (IA dashboard — Sessão A)

| Arquivo | Ação | Motivo |
|---------|------|--------|
| `services/aiDashboard/` | Criado | constants, schema, léxicos, busca, tempo SP, 1ª resposta, heurísticas, saneadores, resolve. Corpos iguais ao HEAD. |
| `services/aiDashboardService.js` | Editado | Passa a importar os módulos; queries/OpenAI/switch permanecem. |
| `tests/aiDashboardSessionA.test.js` | Criado | 35 testes puros. |
| `docs/ai-handoff/22-AI-DASHBOARD-MODULARIZACAO.md` | Atualizado | Sessão A registrada; Sessão B = queries + classify/format + shim. |

## Atualização 2026-08-31 (IA dashboard — plano, código intocado)

| Arquivo | Ação | Motivo |
|---------|------|--------|
| `docs/ai-handoff/22-AI-DASHBOARD-MODULARIZACAO.md` | Criado | Mapa e plano de quebra de `services/aiDashboardService.js`. Código **não** alterado. |
| `docs/README.md`, `docs/AI_HANDOFF.md` | Atualizados | Índice e módulo IA apontam para o doc 22. |
| `docs/ai-handoff/00-LEIA-PRIMEIRO.md` | Atualizado | Item 10 da ordem de leitura (só para essa tarefa). |
| `docs/ai-handoff/02-ESTRUTURA-DO-BACKEND.md`, `04-MODULOS-E-REGRAS-DE-NEGOCIO.md`, `11-TESTES-E-VALIDACAO.md`, `13-PROBLEMAS-CONHECIDOS-E-DIVIDA-TECNICA.md`, `16-MAPA-DE-ARQUIVOS-CRITICOS.md`, `17-CHECKLIST-PARA-PROXIMA-IA.md`, `18-ANTI-PADROES-E-ARMADILHAS.md` | Atualizados | Monolito da IA, zero testes, invariantes (sem SQL livre, dois fusos, não fundir com dashboard HTTP). |

## Atualização 2026-08-31 (UltraMSG quebra executada)

| Arquivo | Ação | Motivo |
|---------|------|--------|
| `docs/ai-handoff/21-ULTRAMSG-PROVIDER-MODULARIZACAO.md` | Atualizado | Quebra em duas sessões; pastas reais; shim `./ultramsg/index.js`. |
| `docs/ai-handoff/00-LEIA-PRIMEIRO.md`, `02-ESTRUTURA-DO-BACKEND.md`, `13-PROBLEMAS-CONHECIDOS-E-DIVIDA-TECNICA.md`, `16-MAPA-DE-ARQUIVOS-CRITICOS.md` | Atualizados | Monolito do adapter marcado como fatiado. |

## Atualização 2026-08-31 (UltraMSG provider)

| Arquivo | Ação | Motivo |
|---------|------|--------|
| `docs/ai-handoff/21-ULTRAMSG-PROVIDER-MODULARIZACAO.md` | Criado | Mapa e plano de quebra de `services/providers/ultramsg.js` (código ainda monolito). |
| `docs/README.md` | Atualizado | Índice e guia de leitura apontam para o doc 21. |
| `docs/ai-handoff/00-LEIA-PRIMEIRO.md` | Atualizado | Item 9 da ordem de leitura (só para essa tarefa). |
| `docs/ai-handoff/06-WHATSAPP-ULTRAMSG-E-WEBHOOKS.md` | Corrigido | Path real `services/providers/ultramsg.js` (não `ultramsgProvider.js`); ponteiro para o 21. |
| `docs/ai-handoff/02-ESTRUTURA-DO-BACKEND.md`, `04-MODULOS-E-REGRAS-DE-NEGOCIO.md`, `13-PROBLEMAS-CONHECIDOS-E-DIVIDA-TECNICA.md`, `16-MAPA-DE-ARQUIVOS-CRITICOS.md`, `17-CHECKLIST-PARA-PROXIMA-IA.md`, `18-ANTI-PADROES-E-ARMADILHAS.md` | Atualizados | Monolito do adapter, quatro APIs de JID, risco de unificar envio/foto/histórico. |
| `docs/AI_HANDOFF.md`, `docs/ai-handoff/11-TESTES-E-VALIDACAO.md` | Atualizados | Ponteiro para o doc 21 e suites do provider. |

## Atualização 2026-08-31

| Arquivo | Ação | Motivo |
|---------|------|--------|
| `docs/ai-handoff/19-ATENDIMENTO-SEM-RESPOSTA-MODULARIZACAO.md` | Criado + atualizado | Mapa e, em 2026-08-31, registro da quebra executada (pastas reais). |
| `docs/README.md` | Atualizado | Índice e guia de leitura apontam para o doc 19. |
| `docs/ai-handoff/00-LEIA-PRIMEIRO.md` | Atualizado | Item 7 da ordem de leitura (só para essa tarefa). |
| `docs/ai-handoff/04-MODULOS-E-REGRAS-DE-NEGOCIO.md` | Atualizado | Linha do módulo de alerta sem resposta. |
| `docs/ai-handoff/05-API-ENDPOINTS.md` | Corrigido | PUT/processar de alerta-sem-resposta são A+SA no código, não AD. |
| `docs/ai-handoff/13-PROBLEMAS-CONHECIDOS-E-DIVIDA-TECNICA.md` | Atualizado | Dívida do monolito + lacuna de testes do processor. |
| `docs/ai-handoff/16-MAPA-DE-ARQUIVOS-CRITICOS.md` | Atualizado | Arquivo do service marcado como alto risco. |
| `docs/ai-handoff/09-JOBS-CRON-E-PROCESSAMENTOS.md` | Atualizado | Ponteiro do scheduler de alerta sem resposta para o doc 19. |
| `docs/ai-handoff/20-DASHBOARD-MODULARIZACAO.md` | Criado | Mapa da quebra de `dashboardController.js`. |
| `docs/ai-handoff/05-API-ENDPOINTS.md` | Atualizado | Rota `GET /dashboard/crm-resumo` documentada. |

---

## Atualização 2026-08-24 (segunda rodada)

| Arquivo | Ação | Motivo |
|---------|------|--------|
| `backend/CLAUDE.md` | Criado | Claude Code lê automaticamente; aponta para AI_HANDOFF, 17-CHECKLIST e 18-ANTI-PADROES; inclui hardstops e vulnerabilidades ativas |
| `CLAUDE.md` (raiz do repo) | Criado | Contexto global: aponta para backend/CLAUDE.md e resume zonas de perigo do frontend |
| `docs/ai-handoff/17-CHECKLIST-PARA-PROXIMA-IA.md` | Atualizado | Adicionados: protocolo de declaração pré-ação, mandato de documentação, validação de PENDENTE |
| `docs/ai-handoff/18-ANTI-PADROES-E-ARMADILHAS.md` | Criado | 15 armadilhas específicas desta codebase (nomes legados, multitenancy, retry cego, socket leak, etc.) |
| `docs/reference/FEATURE-FLAGS.md` | Corrigido | Removida `FEATURE_CAMPANHAS` (módulo deletado); adicionada nota sobre override hard-coded `PROTECAO_DESATIVADA` |
| `docs/README.md` | Atualizado | Doc 18 adicionado ao índice e ao guia de leitura por tarefa |
| `docs/ai-handoff/00-LEIA-PRIMEIRO.md` | Atualizado | Doc 18 adicionado à ordem de leitura |

---

## Documentos criados

| Arquivo | Motivo |
|---------|--------|
| `docs/README.md` | Índice mestre ausente; necessário como ponto de entrada único |
| `docs/AI_HANDOFF.md` | Arquivo compacto de handoff para IAs; documentação existente era só uma pasta com 17 arquivos, sem sumário executivo de uma página |
| `docs/DOCUMENTATION_AUDIT.md` | Este arquivo; rastreabilidade das mudanças |
| `docs/reference/PROTECAO-ENVIO.md` | Módulo `services/protecao/` totalmente indocumentado; `PROTECAO_DESATIVADA=true` é fato crítico operacional |
| `docs/reference/SCRIPTS-CATALOG.md` | 14 scripts em `scripts/` sem qualquer catálogo; frequentemente necessários para manutenção/diagnóstico |
| `docs/reference/chatbot-config-example.json` | Movido de `examples/` (pasta isolada, sem referências) para consolidar com a documentação |
| `public/README.md` | Pasta `public/` continha 3 arquivos sem explicação de propósito |

---

## Documentos atualizados

| Arquivo | O que mudou | Motivo |
|---------|-------------|--------|
| `docs/ai-handoff/00-LEIA-PRIMEIRO.md` | Seção de mudanças pós-auditoria adicionada; módulos removidos registrados | Migrations 20260812* removeram campanha, CRM interno, planos, empresas_whatsapp legado — o documento original não refletia isso |
| `docs/ai-handoff/04-MODULOS-E-REGRAS-DE-NEGOCIO.md` | Módulos removidos marcados explicitamente | Idem |
| `docs/_OFICIAL/ARCHITECTURE.md` | Referência a `campanhaRoutes` corrigida | `routes/campanhaRoutes.js` foi deletado; o documento apontava para rota inexistente |
| `backend/README.md` | Link para nova estrutura de docs; seção de testes adicionada | README estava apontando para `docs/_OFICIAL/README.md` que não é o índice mestre |

---

## Documentos preservados sem alteração

### `docs/ai-handoff/` (17 arquivos — criados em 2026-08-23)

Série completa e muito detalhada criada um dia antes desta auditoria. Preservada integralmente, com exceção dos arquivos `00` e `04` acima. Conteúdo verificado contra o código: preciso e baseado em evidência.

| Arquivo | Status |
|---------|--------|
| `01-ARQUITETURA.md` | Preservado — correto |
| `02-ESTRUTURA-DO-BACKEND.md` | Preservado — correto |
| `03-BANCO-DE-DADOS.md` | Preservado — correto |
| `05-API-ENDPOINTS.md` | Preservado — correto e completo |
| `06-WHATSAPP-ULTRAMSG-E-WEBHOOKS.md` | Preservado — correto |
| `07-SOCKET-IO-E-TEMPO-REAL.md` | Preservado — correto |
| `08-AUTENTICACAO-SEGURANCA-E-MULTITENANCY.md` | Preservado — correto |
| `09-JOBS-CRON-E-PROCESSAMENTOS.md` | Preservado — correto |
| `10-CONFIGURACAO-E-AMBIENTES.md` | Preservado — manifesto completo de env vars |
| `11-TESTES-E-VALIDACAO.md` | Preservado — correto |
| `12-DEPLOY-E-OPERACAO.md` | Preservado — correto |
| `13-PROBLEMAS-CONHECIDOS-E-DIVIDA-TECNICA.md` | Preservado — correto |
| `14-DECISOES-TECNICAS.md` | Preservado — correto |
| `15-GLOSSARIO.md` | Preservado — correto |
| `16-MAPA-DE-ARQUIVOS-CRITICOS.md` | Preservado — correto |
| `17-CHECKLIST-PARA-PROXIMA-IA.md` | Preservado — correto |

### `docs/_OFICIAL/` (8 arquivos)

| Arquivo | Status |
|---------|--------|
| `DATABASE.md` | Preservado — correto; seção 7 (opt-in/campanhas) tornou-se histórico pois tabelas foram removidas |
| `FLOWS.md` | Preservado |
| `PERFORMANCE.md` | Preservado |
| `PROJECT_RULES.md` | Preservado |
| `README.md` | Preservado |
| `ADR-LEGACY-NAMING.md` | Preservado — essencial para entender nomenclatura legada |
| `ULTRAMSG.md` | Preservado |

### Top-level docs

| Arquivo | Status |
|---------|--------|
| `API-CHATS-QUERY.md` | Preservado |
| `API-ENCAMINHAMENTO-MENSAGENS.md` | Preservado |
| `API-HELPDESK-ICTHUS.md` | Preservado |
| `API-MESSAGES-ULTRAMSG.md` | Preservado |
| `API-SUPERVISAO-RELATORIO-DIARIO.md` | Preservado |
| `CHATBOT-SETUP-GUIDE.md` | Preservado |
| `FEATURE-FLAGS.md` | Preservado |
| `TABELA-CONFIGS-OPERACIONAIS.md` | Preservado |
| `PATCH-MULTI-TENANT-ENV.md` | Preservado |

---

## Pasta `_ANTIGOS/` — status

A pasta contém ~70 documentos históricos: relatórios de certificação, prompts para frontend, análises de bugs, checklists temporários. **Nenhum foi deletado** — toda informação válida já está incorporada nos documentos oficiais e na série `ai-handoff/`.

**Recomendação:** esses arquivos podem ser deletados com segurança a qualquer momento. Nenhum contém informação que não esteja documentada em outro lugar da pasta `docs/` atual. O risco de apagar é zero — o histórico está no git.

---

## Reorganização da raiz do backend (2026-08-24, fase 2)

### Arquivos deletados da raiz e do código

| Arquivo | Motivo |
|---------|--------|
| `TODO.md` | Artefato estagnado de sessão de auditoria de IA; todas as tarefas concluídas ou incorporadas nos docs |
| `test-webhook-zapi.ps1` | Já estava no `.gitignore`; endpoint `/webhooks/zapi` não existe mais (é `/webhooks/ultramsg`); supersedido por `scripts/simular-msg-celular.js` |
| `validators/crmValidators.js` | CRM interno removido via migration `20260812130000`; arquivo sem nenhuma referência em controllers/routes/services — dead code |
| `examples/` (pasta inteira) | Continha apenas `chatbot-config-example.json`; movido para `docs/reference/` |

### Arquivos movidos

| De | Para | Motivo |
|----|------|--------|
| `ui-overrides.css` (raiz) | `public/ui-overrides.css` | Pertence a `public/`; app.js atualizado para `path.join(__dirname, 'public', 'ui-overrides.css')` |
| `examples/chatbot-config-example.json` | `docs/reference/chatbot-config-example.json` | Consolidar referências técnicas na pasta `docs/reference/` |

### Arquivos criados

| Arquivo | Motivo |
|---------|--------|
| `public/README.md` | Pasta sem explicação de propósito; 3 arquivos com papéis não óbvios |

---

## Divergências encontradas entre docs e código

| Divergência | Arquivo afetado | Correção aplicada |
|-------------|-----------------|-------------------|
| `campanhaRoutes` referenciado como rota ativa | `_OFICIAL/ARCHITECTURE.md` | Corrigido para "removido" |
| Módulos campanha e CRM interno não marcados como removidos | `ai-handoff/04-MODULOS-E-REGRAS-DE-NEGOCIO.md` | Seção adicionada |
| `docs/_OFICIAL/DATABASE.md` seção 7 lista tabelas de campanha como ativas | Não corrigido diretamente — migração as removeu; o documento antecede essa remoção | Nota adicionada na seção relevante em `AI_HANDOFF.md` |
| `ai-handoff/00-LEIA-PRIMEIRO.md` não menciona mudanças pós commit-base | Corrigido com seção específica | — |

---

## Documentos com informação PENDENTE DE VALIDAÇÃO

Os documentos abaixo contêm seções marcadas explicitamente como não confirmadas em ambiente real:

- `ai-handoff/12-DEPLOY-E-OPERACAO.md` — estado real da VPS, nginx, SSL
- `ai-handoff/09-JOBS-CRON-E-PROCESSAMENTOS.md` — agendador externo de cron em produção
- `ai-handoff/10-CONFIGURACAO-E-AMBIENTES.md` — versão Node.js fixada, configuração de produção
- `ai-handoff/13-PROBLEMAS-CONHECIDOS-E-DIVIDA-TECNICA.md` — estado real das migrations na VPS
- `ai-handoff/03-BANCO-DE-DADOS.md` — tabela `helpdesk_notificacoes` não encontrada nas migrations

Estes itens requerem acesso ao banco/VPS para confirmação. Não foram alterados.
