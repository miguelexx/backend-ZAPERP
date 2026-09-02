# Checklist para a próxima IA

> Análise: 2026-08-23 · `master` · commit-base `66e0771d9f61f840524cd4b0645e742df374a77a`.  
> Atualizado: 2026-08-24 — adicionados protocolos de declaração pré-ação e mandato de documentação.

## Declaração pré-ação (obrigatório antes de escrever qualquer código)

Antes de tocar em qualquer arquivo, declare explicitamente:

- [ ] **Módulos e arquivos afetados** — listar os arquivos que serão lidos e/ou editados
- [ ] **Riscos de regressão** — o que pode quebrar além do que está sendo alterado
- [ ] **Testes existentes relevantes** — quais suites cobrem o módulo
- [ ] **Dependências de infraestrutura** — precisa de migration? De atualizar evento Socket.IO? De variável de ambiente nova?

Não prosseguir sem esta declaração. Se o escopo for maior do que esperado, reportar antes de implementar.

## Mandato de documentação (obrigatório ao terminar)

- [ ] Se encontrou algo relevante ao sistema que **não estava documentado** → adicionar ao doc correspondente em `docs/ai-handoff/` antes de encerrar
- [ ] Se um item está marcado **PENDENTE DE VALIDAÇÃO** e você validou no código → atualizar o status no doc
- [ ] Nunca encerrar a sessão com conhecimento novo não registrado

## Antes de qualquer alteração

- [ ] Ler [00](00-LEIA-PRIMEIRO.md), [arquitetura](01-ARQUITETURA.md), [banco](03-BANCO-DE-DADOS.md), [segurança](08-AUTENTICACAO-SEGURANCA-E-MULTITENANCY.md), [riscos](13-PROBLEMAS-CONHECIDOS-E-DIVIDA-TECNICA.md), [mapa crítico](16-MAPA-DE-ARQUIVOS-CRITICOS.md) e [anti-padrões](18-ANTI-PADROES-E-ARMADILHAS.md).
- [ ] Executar `git status --short` e distinguir mudanças preexistentes. Nunca descartar trabalho do usuário.
- [ ] Declarar escopo e não analisar/alterar frontend.
- [ ] Localizar route → controller → service/helper/repository → migration → teste. Buscar também aliases e chamadas legadas; nome “Zapi” não significa inativo.
- [ ] Tarefa no adapter UltraMSG (`services/providers/ultramsg.js`): ler [21](21-ULTRAMSG-PROVIDER-MODULARIZACAO.md) antes de fatiar ou unificar JID.
- [ ] Tarefa no assistente IA (`services/aiDashboardService.js` / `POST /ai/ask`): ler [22](22-AI-DASHBOARD-MODULARIZACAO.md). Sessão A **já feita** (35 testes puros). Não repetir extração de clamp/tempo/heurística. Sessão B = queries + classify/format. Não confundir com dashboard HTTP nem com alerta sem resposta.
- [ ] Tarefa no chat HTTP: ler [23](23-CHAT-CONTROLLER-MODULARIZACAO.md) + [`CHAT_ARQUITETURA_MODULAR.md`](../CHAT_ARQUITETURA_MODULAR.md). Fachada **já é shim**. **Não reextrair** lista/texto/PIX. Não descartar `conversationListController.js` / `textMessageController.js` / `pixController.js` se estiverem untracked.
- [ ] Tarefa no webhook inbound/ACK: ler [24](24-WEBHOOK-INBOUND-MODULARIZACAO.md). Fases 1–4 já em `controllers/webhookInbound/`; fase 5 fatia o miolo de `receberZapi` (com caracterização em `tests/receberZapiInbound.test.js`). **Não** mover `receberZapi`/`statusZapi` sem o mapa. Não renomear o arquivo. Preservar untracked do chat.
- [ ] Para qualquer item marcado **PENDENTE DE VALIDAÇÃO** relevante à tarefa: validar no código antes de assumir como verdade.

## Banco e multitenancy

- [ ] Tratar migrations ordenadas como fonte; `schema.sql` é apenas contexto. Comparar migration posterior que altera/remove o objeto.
- [ ] Não assumir migration aplicada. Para banco real, pedir inventário/autorização e marcar **PENDENTE DE VALIDAÇÃO**.
- [ ] Derivar `company_id` de JWT, instância ou credencial confiável; ignorar tenant do body/query.
- [ ] Aplicar tenant em SELECT/INSERT/UPDATE/DELETE, joins, RPCs, rooms, caches, arquivos e exports.
- [ ] Criar teste negativo com empresa A tentando id de B. Lembrar que service role ignora RLS.

## Mensagens, webhooks e tempo real

- [ ] Mapear persistência antes/depois do provider, `client_temp_id`, `referenceId`, provider id e constraint.
- [ ] Simular callback duplicado, ACK fora de ordem, timeout antes/depois de chamar UltraMSG, fromMe e instâncias diferentes com o mesmo telefone.
- [ ] Nunca regredir status nem reenviar `pending/incerta` sem evidência/reconciliação.
- [ ] Emitir para a sala mínima e testar empresa, departamento, usuário e conversa. Considerar reload/reconexão: HTTP/DB deve recompor estado.
- [ ] Não adicionar listener por requisição nem presumir Redis; há apenas um processo suportado.

## Testar sem atingir clientes

- [ ] Usar Jest/Supertest, mock Supabase/provider/fetch/R2/push/OpenAI e fixtures fictícias.
- [ ] Definir `NODE_ENV=test` e `ZAPERP_DISABLE_BACKGROUND_JOBS=1`; não iniciar `index.js`/worker desnecessariamente.
- [ ] Ler a suite antes de fixar flags: testes live de Disparo são live **somente contra mock**, mas hoje dois casos divergem do gate `workerEnabled`.
- [ ] Nunca usar `.env` de produção, número real, serviço real, QR/restart, sync, cron, script de carga/admin ou campanha live.
- [ ] Validar UltraMSG real somente com autorização explícita, tenant/número de homologação, allowlist e teto definido.

## Avaliação de impacto

- [ ] API: método, aliases bare/`/api`, auth/perfil/permissão, validação, status/erros.
- [ ] Banco: campos/constraints/índices/RLS, compatibilidade com linhas legadas e concorrência.
- [ ] Webhook/provider: formato, idempotência, resposta HTTP, retry e estado incerto.
- [ ] Socket/push: sala, payload, duplicidade, offline/reload.
- [ ] Mídia: tipo real, tamanho, SSRF, redirect, temporário, R2/local e retenção.
- [ ] Jobs: repetição, restart, múltiplos processos e locks persistentes.

## Documentação e entrega

- [ ] Atualizar estes arquivos quando mudar arquitetura, API, banco, integração, evento, env ou regra.
- [ ] Citar caminhos/evidência e distinguir **CONFIRMADO**, **PROVÁVEL/INFERÊNCIA** e **NÃO CONFIRMADO/PENDENTE**.
- [ ] Rodar validação de links, inventário de rotas/tabelas/eventos/env, scan de segredos e `git diff --stat`/`git diff`.
- [ ] Informar testes realmente executados e suas falhas; nunca afirmar “passou” por suposição.

## Nunca executar automaticamente

Migration, deploy, commit, push, alteração de banco real, worker live, envio WhatsApp, restart/configuração de instância, cron, sync externo, retenção/limpeza, rotação de segredo ou script destrutivo. Se a tarefa exigir qualquer um, parar, explicar alvo/risco/plano de rollback e solicitar autorização explícita.

Quando faltar evidência, relatar exatamente arquivo/estado consultado, hipótese e validação necessária. Não preencher lacuna com memória de conversa ou documentação antiga.

