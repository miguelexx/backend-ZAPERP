# Leia primeiro — handoff do backend ZapERP

> Análise estática em 2026-08-23, branch `master`, commit-base `66e0771d9f61f840524cd4b0645e742df374a77a`. A árvore já continha mudanças não commitadas, sobretudo a Etapa 9 de Disparo. Nenhuma afirmação sobre banco/VPS significa que a migration ou o código estejam implantados.

## Objetivo e estado

Backend Node.js/CommonJS para atendimento WhatsApp multiempresa: HTTP Express, Socket.IO, Supabase/PostgreSQL, UltraMSG, mídia local/R2, chatbot, alertas, help desk, produtos e campanhas de disparo. O processo principal é funcional e coberto por 100 arquivos Jest; o módulo Disparo está em evolução e possui arquivos da Etapa 9 ainda fora do commit-base.

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
6. [decisões](14-DECISOES-TECNICAS.md), [glossário](15-GLOSSARIO.md) e [checklist](17-CHECKLIST-PARA-PROXIMA-IA.md).

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
- Etapa 9 de Disparo está no working tree: health operacional, lease `enviando -> incerta`, contadores de resposta/opt-out e testes. Aplicação da migration é `PENDENTE DE VALIDAÇÃO`.
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
