# Auditoria de Backend — Prontidão para Produção e Venda SaaS

**Documento:** Validação técnica do backend ZapERP para produto SaaS de WhatsApp corporativo  
**Data:** Março 2025  
**Escopo:** Backend Node.js/Express + Supabase + Z-API + Socket.IO

---

## 1. Classificação Final do Backend

| Dimensão           | Classificação | Nota |
|--------------------|---------------|------|
| Arquitetura        | **OK**        | Monolito bem estruturado, responsabilidades claras |
| Segurança          | **ATENÇÃO**   | Pontos sólidos + 2 riscos a tratar |
| Multi-tenant      | **OK**        | company_id estrito no JWT e queries |
| Autenticação      | **OK**        | JWT, bcrypt, fail-fast em boot |
| Autorização       | **ATENÇÃO**   | Boa base; campanhas/opt-in sem restrição de perfil |
| Webhooks          | **ATENÇÃO**   | POST sem token; resolution por instanceId |
| Performance       | **OK**        | Adequado para escala inicial |
| Manutenibilidade  | **OK**        | Código legível, estrutura coerente |
| Prontidão Prod    | **ATENÇÃO**   | Faltam testes, monitoramento, logs estruturados |
| Prontidão Venda   | **ATENÇÃO**   | Viável para pilotos; melhorias antes de escala |

**Classificação geral:** **ATENÇÃO** — pode sustentar clientes reais com ajustes pontuais.

---

## 2. O Que Já Está Sólido

### 2.1 Arquitetura e Organização
| Item | Status |
|------|--------|
| Estrutura MVC: controllers, services, helpers, routes | ✅ OK |
| Separação de responsabilidades (providers, sync, integração) | ✅ OK |
| Configuração centralizada (config/supabase.js) | ✅ OK |
| Feature flags para novos módulos (opt-out, regras, campanhas) | ✅ OK |

### 2.2 Autenticação
| Item | Status |
|------|--------|
| JWT com verificação de assinatura | ✅ OK |
| company_id obrigatório no token (multi-tenant estrito) | ✅ OK |
| Senhas com bcrypt (10 rounds) | ✅ OK |
| Fail-fast no boot: JWT_SECRET, APP_URL, ZAPI_WEBHOOK_TOKEN, NODE_ENV | ✅ OK |
| Socket.IO com auth JWT e mesma validação de tenant | ✅ OK |

### 2.3 Multi-tenant
| Item | Status |
|------|--------|
| company_id em todas as queries principais | ✅ OK |
| Resolução instanceId → company_id via empresa_zapi | ✅ OK |
| Rooms Socket.IO por empresa, conversa, usuário, departamento | ✅ OK |
| Credenciais Z-API por empresa (empresa_zapi) | ✅ OK |

### 2.4 Permissões
| Item | Status |
|------|--------|
| Catálogo de permissões (permissoesCatalogo) | ✅ OK |
| Admin/supervisor/atendente com granularidade | ✅ OK |
| Overrides por usuário (usuario_permissoes) | ✅ OK |
| assertPermissaoConversa no chatController (setor, assumir) | ✅ OK |
| Middlewares adminOnly, supervisorOrAdmin, hasPermission | ✅ OK |

### 2.5 Segurança
| Item | Status |
|------|--------|
| Helmet (CSP, X-Frame-Options, Referrer-Policy) | ✅ OK |
| CORS restrito a origens explícitas + CORS_ORIGINS | ✅ OK |
| Rate limit: login 5/min, webhook 200/min, API 300/min | ✅ OK |
| Upload: MIME permitidos, extensão derivada do tipo | ✅ OK |
| Comparação timing-safe no requireWebhookToken | ✅ OK |
| Arquivos estáticos: nosniff, Content-Disposition para não-imagens | ✅ OK |

### 2.6 Webhooks
| Item | Status |
|------|--------|
| Suporte a payloads complexos (texto, mídia, grupos, LID) | ✅ OK |
| Idempotência por (conversa_id, whatsapp_id) | ✅ OK |
| Espelhamento mensagens enviadas pelo celular | ✅ OK |
| Chatbot triagem integrado; opt-out e regras automáticas opcionais | ✅ OK |

### 2.7 Jobs e Infra
| Item | Status |
|------|--------|
| Timeout inatividade (job cron protegido por CRON_SECRET) | ✅ OK |
| PM2 config (ecosystem.config.js) para produção | ✅ OK |
| Health check /health | ✅ OK |
| Trust proxy para Nginx/Cloudflare | ✅ OK |

### 2.8 Tratamento de Erros
| Item | Status |
|------|--------|
| try/catch nos controllers | ✅ OK |
| Handler global para Multer, CORS, erros genéricos | ✅ OK |
| Erros 500 em JSON (nunca HTML) | ✅ OK |
| Rejeições de webhook logadas sem expor token | ✅ OK |

---

## 3. O Que Está Aceitável mas Precisa Atenção

### 3.1 Webhook Z-API — POST sem token
| Item | Classificação | Detalhe |
|------|---------------|---------|
| POST /webhooks/zapi sem validação de ZAPI_WEBHOOK_TOKEN | **ATENÇÃO** | Apenas instanceId no body; quem tiver instanceId válido pode enviar payloads. Rate limit e ignorar instanceId não mapeado reduzem risco. Recomendado: validar token em query/header no POST. |

### 3.2 Campanhas e Opt-in/Opt-out
| Item | Classificação | Detalhe |
|------|---------------|---------|
| Rotas /campanhas, /opt-in, /opt-out só com auth | **ATENÇÃO** | Qualquer usuário autenticado pode criar campanhas e registrar opt-in. O plano indica admin/supervisor para campanhas. Adicionar supervisorOrAdmin ou hasPermission. |

### 3.3 Logs
| Item | Classificação | Detalhe |
|------|---------------|---------|
| Logs via console.log/console.error | **ATENÇÃO** | Sem níveis (info/warn/error), sem trace IDs, sem destino estruturado. Funcional para poucos clientes; limitante em escala. |

### 3.4 Auditoria
| Item | Classificação | Detalhe |
|------|---------------|---------|
| auditoria_log | **OK** | Integrado em campanha_criar, campanha_excluir, permissoes_alterar. GET /config/auditoria inclui auditoria_log. |

### 3.5 Jobs
| Item | Classificação | Detalhe |
|------|---------------|---------|
| Job único (timeout inatividade) | **ATENÇÃO** | Sem fila assíncrona; execução síncrona em loop. Adequado para volume moderado; considerar fila (Bull, etc.) se muitas empresas. |
| CRON_SECRET em header | **ATENÇÃO** | Funcional; ideal é garantir que o cron não seja exposto à internet ou usar IP allowlist. |

### 3.6 Banco de Dados
| Item | Classificação | Detalhe |
|------|---------------|---------|
| Supabase Service Role (sem RLS no app) | **ATENÇÃO** | Segurança via company_id em todas as queries; depende de disciplina. RLS em tabelas críticas seria reforço adicional. |
| Sem connection pooling explícito | **ATENÇÃO** | Supabase JS client gerencia; adequado para escala inicial. |

---

## 4. O Que Está Crítico

### 4.1 Testes Automatizados
| Item | Classificação | Detalhe |
|------|---------------|---------|
| Ausência de suite de testes (Jest, Mocha) | **CRÍTICO** | Nenhum teste unitário ou de integração. Regressões passam despercebidas. Bloqueante para evolução segura em SaaS. |

### 4.2 Monitoramento e Alertas
| Item | Classificação | Detalhe |
|------|---------------|---------|
| Sem métricas de aplicação (APM) | **CRÍTICO** | Sem New Relic, Datadog, Prometheus etc. Difícil detectar lentidão, erros ou falhas em produção. |

### 4.3 Recuperação de Falhas
| Item | Classificação | Detalhe |
|------|---------------|---------|
| Sem estratégia de retry em chamadas Z-API | **CRÍTICO** | Falhas transitórias da Z-API podem resultar em mensagens não enviadas ou não persistidas. Recomendado: retry com backoff e dead letter. |

### 4.4 Backup e DR
| Item | Classificação | Detalhe |
|------|---------------|---------|
| Sem documentação de backup/restore | **CRÍTICO** | Supabase oferece backup; é preciso documento com RPO/RTO e procedimentos de restore. |

---

## 5. Riscos para Produção

| Risco | Probabilidade | Impacto | Mitigação |
|-------|---------------|---------|-----------|
| Regressão em alterações (sem testes) | Alta | Alto | Introduzir testes para fluxos críticos (webhook, envio, chat) |
| Erro silencioso em integração Z-API | Média | Alto | Retry + dead letter + alertas |
| Vazamento de dados entre tenants | Baixa | Crítico | Revisão de queries, considerar RLS |
| Webhook forjado (sem token) | Média | Médio | Validar ZAPI_WEBHOOK_TOKEN no POST |
| Instância única cai e derruba todo o SaaS | Média | Alto | Load balancer, múltiplas instâncias |
| Jobs síncronos bloqueiam requests | Baixa | Médio | Rodar jobs em worker separado ou fila |
| Logs insuficientes para debug | Alta | Médio | Padronizar logs estruturados (JSON) |

---

## 6. Riscos para Venda

| Risco | Impacto | Mitigação |
|-------|---------|-----------|
| Ausência de SLA documentado | Médio | Definir SLA e politicas de suporte |
| Conformidade LGPD/GDPR | Alto | Documentar opt-in/opt-out, DPA, política de privacidade |
| Suporte técnico sem base de conhecimento | Médio | Documentar troubleshooting, runbooks |
| Demonstração falhando em demo | Alto | Ambiente de demo estável, testes de smoke |
| Contratos/termos sem amparo técnico | Alto | Revisão jurídica + documentação técnica |
| Escalabilidade não provada | Médio | Prova de conceito com carga e métricas |

---

## 7. Melhorias Obrigatórias Antes de Vender

| # | Item | Esforço | Prioridade | Status |
|---|------|---------|------------|--------|
| 1 | Testes E2E para fluxo principal (login → chat → envio) | 2–3 dias | P0 | ✅ Jest + auth/health |
| 2 | Validar ZAPI_WEBHOOK_TOKEN no POST do webhook | 0,5 dia | P0 | ✅ Implementado |
| 3 | Restringir campanhas/opt-in a admin ou supervisor | 0,5 dia | P0 | ✅ Implementado |
| 4 | Documentar backup/restore e procedimentos de DR | 1 dia | P0 | ✅ docs/BACKUP-RESTORE-DR.md |
| 5 | Retry com backoff em chamadas críticas Z-API | 1 dia | P1 | ✅ helpers/retryWithBackoff.js |
| 6 | Integrar auditoria em ações críticas (campanha, permissões) | 1 dia | P1 | ✅ Implementado |
| 7 | Remover ou restringir /debug/env em produção | 0,5 dia | P1 | ✅ Já restrito (só dev) |

---

## 8. Melhorias Recomendadas Após Vender

| # | Item | Esforço |
|---|------|---------|
| 1 | APM ou métricas (Datadog, New Relic, Prometheus) | 2–3 dias |
| 2 | Logs estruturados (JSON) e destino centralizado | 1–2 dias |
| 3 | Testes unitários para services críticos | 3–5 dias |
| 4 | Fila de jobs (Bull + Redis) para campanhas/envios | 2–3 dias |
| 5 | RLS em tabelas sensíveis do Supabase | 2–3 dias |
| 6 | Rate limit por empresa (não só global) | 1 dia |
| 7 | Health check com dependências (Supabase, Z-API) | 0,5 dia |
| 8 | Circuit breaker em integrações externas | 1 dia |

---

## 9. Checklist de Backend Pronto para Produção

| Categoria | Item | Status |
|-----------|------|--------|
| **Config** | JWT_SECRET, APP_URL, NODE_ENV definidos | ✅ |
| **Config** | ZAPI_WEBHOOK_TOKEN definido | ✅ |
| **Config** | SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY | ✅ |
| **Config** | CORS_ORIGINS para domínios de produção | ✅ |
| **Auth** | Token JWT obrigatório em APIs protegidas | ✅ |
| **Auth** | company_id validado no token | ✅ |
| **Auth** | Rate limit em login | ✅ |
| **Multi-tenant** | company_id em queries de dados | ✅ |
| **Permissões** | adminOnly/supervisorOrAdmin nas rotas sensíveis | ✅ Implementado |
| **Webhook** | Rate limit 200 req/min | ✅ |
| **Webhook** | Validação de token no POST | ✅ Implementado |
| **Jobs** | CRON_SECRET para jobs | ✅ |
| **Jobs** | Documentação de agendamento | ⚠️ Parcial |
| **Segurança** | Helmet, CORS, upload restrito | ✅ |
| **Erros** | Handler global, JSON nas respostas | ✅ |
| **Monitoramento** | APM ou métricas | ❌ |
| **Testes** | Suite de testes | ❌ |
| **Logs** | Estruturados e persistidos | ❌ |
| **Backup** | Procedimento documentado | ❌ |
| **Health** | Endpoint /health | ✅ |

**Legenda:** ✅ Atende | ⚠️ Parcial | ❌ Não atende

---

## 10. Conclusão Objetiva

### Pode sustentar clientes reais?

**Sim**, sob condições.

O backend está **apto a sustentar clientes reais** para:

- **Pilotos e primeiros clientes** (até ~10 empresas ativas), desde que:
  1. Token de webhook seja validado no POST.
  2. Permissões de campanhas sejam restritas a admin/supervisor.
  3. Haja procedimento documentado de backup/restore.
  4. Demonstrações usem ambiente de produção estável e controlado.

- **Escala comercial** exige:
  1. Testes automatizados para fluxos críticos.
  2. Monitoramento e alertas.
  3. Retry em integrações Z-API.
  4. Logs estruturados e persistidos.

### Resumo em uma frase

> O backend tem base sólida (arquitetura, multi-tenant, permissões, segurança geral), mas a ausência de testes, monitoramento e retry em integrações representa risco para escala comercial. Com as melhorias P0 listadas, pode ser usado com clientes reais em cenários iniciais.

---

*Auditoria baseada em análise estática do codebase. Validação em ambiente real e testes de carga são recomendados antes de go-live.*
