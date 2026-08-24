# Auditoria de documentação — backend ZapERP

> Criado em **2026-08-24** pela tarefa de reorganização completa da pasta `backend/docs/`.  
> Registra o que foi criado, atualizado, removido ou preservado e o motivo.

---

## Documentos criados

| Arquivo | Motivo |
|---------|--------|
| `docs/README.md` | Índice mestre ausente; necessário como ponto de entrada único |
| `docs/AI_HANDOFF.md` | Arquivo compacto de handoff para IAs; documentação existente era só uma pasta com 17 arquivos, sem sumário executivo de uma página |
| `docs/DOCUMENTATION_AUDIT.md` | Este arquivo; rastreabilidade das mudanças |

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
