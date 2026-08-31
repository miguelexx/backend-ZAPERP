# Backend ZapERP — Documentação

> Atualizado: **2026-08-31** · branch `master` · fonte normativa = código + migrations.

---

## Começo rápido para IAs

**Leia primeiro:** [`AI_HANDOFF.md`](AI_HANDOFF.md) — contexto completo em uma página.  
**Análise técnica profunda:** [`ai-handoff/00-LEIA-PRIMEIRO.md`](ai-handoff/00-LEIA-PRIMEIRO.md) — série de documentos especializados.

---

## Estrutura desta pasta

```
docs/
├── AI_HANDOFF.md               ← começa aqui: stack, módulos, fluxos, regras, riscos
├── README.md                   ← este arquivo (índice)
├── DOCUMENTATION_AUDIT.md     ← histórico de mudanças na documentação
│
├── ai-handoff/                 ← referência técnica completa
│   ├── 00-LEIA-PRIMEIRO.md    estado, limitações, ordem de leitura
│   ├── 01-ARQUITETURA.md      diagrama, camadas, HTTP, async
│   ├── 02-ESTRUTURA-DO-BACKEND.md  pastas, responsabilidades
│   ├── 03-BANCO-DE-DADOS.md   tabelas, migrations, multi-tenant, índices
│   ├── 04-MODULOS-E-REGRAS-DE-NEGOCIO.md  todos os módulos, regras, riscos
│   ├── 05-API-ENDPOINTS.md    inventário completo de rotas
│   ├── 06-WHATSAPP-ULTRAMSG-E-WEBHOOKS.md  fluxo de webhook, ACK, mídia
│   ├── 07-SOCKET-IO-E-TEMPO-REAL.md  salas, eventos, contrato
│   ├── 08-AUTENTICACAO-SEGURANCA-E-MULTITENANCY.md
│   ├── 09-JOBS-CRON-E-PROCESSAMENTOS.md  schedulers, worker disparo, fila
│   ├── 10-CONFIGURACAO-E-AMBIENTES.md  manifesto completo de env vars
│   ├── 11-TESTES-E-VALIDACAO.md
│   ├── 12-DEPLOY-E-OPERACAO.md  PM2, health, rollback, checklist
│   ├── 13-PROBLEMAS-CONHECIDOS-E-DIVIDA-TECNICA.md
│   ├── 14-DECISOES-TECNICAS.md  ADRs
│   ├── 15-GLOSSARIO.md
│   ├── 16-MAPA-DE-ARQUIVOS-CRITICOS.md  qual arquivo ler para cada tarefa
│   ├── 17-CHECKLIST-PARA-PROXIMA-IA.md
│   ├── 18-ANTI-PADROES-E-ARMADILHAS.md  armadilhas específicas desta codebase
│   ├── 19-ATENDIMENTO-SEM-RESPOSTA-MODULARIZACAO.md  plano/mapa do alerta sem resposta
│   ├── 20-DASHBOARD-MODULARIZACAO.md  quebra do dashboardController
│   ├── 21-ULTRAMSG-PROVIDER-MODULARIZACAO.md  adapter UltraMSG (pasta + shim)
│   └── 22-AI-DASHBOARD-MODULARIZACAO.md  assistente IA `/ai/ask` (Sessão A: puros extraídos)
│
└── reference/                  ← referência suplementar por domínio
    ├── PROJECT_RULES.md        regras do projeto (multi-tenant, segurança, padrões)
    ├── ADR-LEGACY-NAMING.md   nomenclatura legada zapi_* vs UltraMSG atual
    ├── PROTECAO-ENVIO.md      módulo de rate limit + opt-in (ATUALMENTE DESATIVADO)
    ├── SCRIPTS-CATALOG.md     catálogo de todos os scripts de manutenção em scripts/
    ├── chatbot-config-example.json  exemplo completo de config do chatbot de triagem
    ├── API-CHATS-QUERY.md     parâmetros de query de /chats
    ├── API-ENCAMINHAMENTO-MENSAGENS.md
    ├── API-HELPDESK-ICTHUS.md integração help desk externa
    ├── API-MESSAGES-ULTRAMSG.md  tipos de mensagem UltraMSG
    ├── API-SUPERVISAO-RELATORIO-DIARIO.md
    ├── CHATBOT-SETUP-GUIDE.md configuração do chatbot
    ├── FEATURE-FLAGS.md       flags e configuração operacional
    ├── HELPDESK-NOTIFICACOES.md
    └── TABELA-CONFIGS-OPERACIONAIS.md
```

---

## Guia de leitura por tarefa

| Tarefa | Leia |
|--------|------|
| Entender o sistema do zero | `AI_HANDOFF.md` |
| Adicionar/alterar uma rota | `ai-handoff/05-API-ENDPOINTS.md` → controller relevante |
| Alterar banco (migration) | `ai-handoff/03-BANCO-DE-DADOS.md` |
| Trabalhar com webhooks UltraMSG | `ai-handoff/06-WHATSAPP-ULTRAMSG-E-WEBHOOKS.md` |
| Modularizar o adapter UltraMSG (`services/providers/ultramsg.js`) | `ai-handoff/21-ULTRAMSG-PROVIDER-MODULARIZACAO.md` |
| Eventos Socket.IO | `ai-handoff/07-SOCKET-IO-E-TEMPO-REAL.md` |
| Schedulers / jobs / worker | `ai-handoff/09-JOBS-CRON-E-PROCESSAMENTOS.md` |
| Variáveis de ambiente | `ai-handoff/10-CONFIGURACAO-E-AMBIENTES.md` |
| Deploy / operação | `ai-handoff/12-DEPLOY-E-OPERACAO.md` |
| Riscos e dívida técnica | `ai-handoff/13-PROBLEMAS-CONHECIDOS-E-DIVIDA-TECNICA.md` |
| Nomes "zapi" no código | `reference/ADR-LEGACY-NAMING.md` |
| Regras obrigatórias do projeto | `reference/PROJECT_RULES.md` |
| Módulo de Disparo (campanhas) | `ai-handoff/04-MODULOS-E-REGRAS-DE-NEGOCIO.md` |
| Autenticação / permissões | `ai-handoff/08-AUTENTICACAO-SEGURANCA-E-MULTITENANCY.md` |
| Qualquer mudança nova | `ai-handoff/17-CHECKLIST-PARA-PROXIMA-IA.md` |
| Evitar erros comuns de IAs | `ai-handoff/18-ANTI-PADROES-E-ARMADILHAS.md` |
| Modularizar alerta sem resposta | `ai-handoff/19-ATENDIMENTO-SEM-RESPOSTA-MODULARIZACAO.md` |
| Modularizar dashboard HTTP (`dashboardController`) | `ai-handoff/20-DASHBOARD-MODULARIZACAO.md` |
| Modularizar assistente IA (`aiDashboardService.js`) | `ai-handoff/22-AI-DASHBOARD-MODULARIZACAO.md` |
| Proteção de envio / rate limit / opt-in | `reference/PROTECAO-ENVIO.md` |
| Scripts de manutenção / diagnóstico / R2 | `reference/SCRIPTS-CATALOG.md` |

---

## Regra de manutenção

Ao alterar arquitetura, API, banco, integrações, sockets ou regras de negócio:  
**atualizar o documento correspondente no mesmo trabalho.**  
Marcar o que não puder confirmar como `NÃO CONFIRMADO` ou `PENDENTE DE VALIDAÇÃO`.
