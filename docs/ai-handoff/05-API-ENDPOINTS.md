# Inventário da API HTTP

> Análise estática: 2026-08-23 · branch `master` · commit-base `66e0771d9f61f840524cd4b0645e742df374a77a` · evidências: `app.js`, `routes/*.js`, controllers e middlewares citados. Não houve chamada a endpoint real.

## Índice

[Leitura](#como-ler-este-inventário) · [infra/webhooks](#infraestrutura-e-webhooks) · [usuários/configuração](#usuários-empresa-permissões-e-configuração) · [clientes/chats](#clientes-tags-conversas-e-mensagens) · [dashboard/IA](#dashboard-supervisão-ia-chatbot-e-produtos) · [WhatsApp](#instâncias-e-integração-whatsapp) · [integrações](#chat-interno-help-desk-push-e-integrações-auxiliares) · [jobs](#jobs-http) · [Disparo](#disparo) · [manifesto literal](#manifesto-literal-validado-das-rotas)

## Como ler este inventário

Com exceção de health, arquivos estáticos e webhooks, cada rota abaixo é montada no caminho mostrado **e também sob `/api`** por `app.js`. `/integrations/zapi` é alias de `/integrations/whatsapp`. `apiLimiter` envolve os módulos; `auth` valida JWT e injeta `req.user`; `A` = `auth`, `AD` = `adminOnly`, `SA` = `supervisorOrAdmin`, `D` = `destructiveLimiter`. Parâmetros `:id` são identificadores da entidade; filtros/paginação vêm de `req.query`; corpos são JSON salvo quando indicado upload. Controllers validam campos específicos e respondem em geral com JSON `2xx`; erros usuais são `400` (entrada/estado), `401`, `403`, `404`, `409`, `429` e `500/502/503`.

Todas as operações autenticadas devem limitar consultas por `req.user.company_id`. Escritas alteram as tabelas do módulo; operações de atendimento/mensagem também podem emitir eventos de [Socket.IO](07-SOCKET-IO-E-TEMPO-REAL.md), enviar push e chamar UltraMSG. Para os contratos de mensagem e estados, ver [06](06-WHATSAPP-ULTRAMSG-E-WEBHOOKS.md). Não se deve inferir um schema de body além das validações do controller indicado.

## Infraestrutura e webhooks

| Método e caminho | Controller/middleware | Contrato e efeitos |
|---|---|---|
| `GET /health` | inline em `app.js` | Sem auth; retorna `{ok:true}`. Não identifica build. |
| `GET /health/detailed` | inline em `app.js` | Sem auth; testa acesso Supabase e informa estado, sem segredo. |
| `GET /webhooks/ultramsg/health` e alias `/webhooks/whatsapp/health` | `webhookLimiter`; `healthUltramsg` | Diagnóstico público sanitizado. |
| `GET /webhooks/ultramsg/` e alias | `webhookLimiter`; `testarUltramsg` | Verificação básica do endpoint. |
| `POST /webhooks/ultramsg/` e alias | limiter, `requireWebhookToken`, `resolveWebhookInstance`; `webhookUltramsgController` | Body UltraMSG. Resolve instância/tenant, normaliza inbound ou ACK, persiste e emite eventos. `401/403/404/429/500`; detalhes em [06](06-WHATSAPP-ULTRAMSG-E-WEBHOOKS.md). |
| `GET /uploads/*` | middleware inline/static | Arquivo local por nome não previsível; `nosniff`, sem JWT. |
| `GET /permissoes` | inline em `app.js`; serve `public/permissoes.html` | Sem auth HTTP; página HTML estática de referência do catálogo de permissões. Uso interno/admin pelo navegador. |
| `GET /painel-supervisao` | inline em `app.js`; serve `public/supervisao.html` | Sem auth HTTP; painel HTML de supervisão autônomo. Uso interno/admin pelo navegador. |
| `GET /media/r2/*` | inline em `app.js` | Redireciona para URL R2 assinada quando objeto está autorizado. |
| `GET /media/proxy?url=...` | `authBearerOrQuery`; `mediaProxyController.proxyMedia` | JWT Bearer ou `access_token`; busca HTTPS de host permitido, valida redirects/tamanho. Não grava banco. |

## Usuários, empresa, permissões e configuração

| Rotas | Controller | Segurança, entrada e efeito |
|---|---|---|
| `POST /usuarios/login` | `userController.login` | `loginLimiter`; email/senha e contexto de empresa; verifica bcrypt/ativo, retorna JWT. |
| `GET /usuarios`, `POST /usuarios`, `PUT /usuarios/:id`, `DELETE /usuarios/:id` | `userController` (`listar/criar/atualizar/excluir`) | A; mutações AD, delete AD+D. JSON de usuário/perfil/departamentos; tabela `usuarios`. |
| `POST /usuarios/resetar-senha-email`, `POST /usuarios/:id/redefinir-senha` | `userController` | A+AD; redefine credencial, sem expor hash. |
| `GET /usuarios/me`, `PATCH /usuarios/me` | `getMe/patchMe` | A; lê/edita campos próprios permitidos. |
| `GET /usuarios/me/permissoes`, `GET/PUT /usuarios/:id/permissoes` | `permissoesController` | A; PUT também AD; lê/grava overrides de permissões. |
| `GET /usuarios/push/vapid-public-key`, `POST/DELETE /usuarios/me/push/subscribe`, `POST /usuarios/me/push/test` | `pushController` | Chave pública sem A; demais A. Subscription JSON, grava/remove e pode enviar push de teste. |
| `GET /config/empresa` | `configController.getEmpresa` | A, inclusive atendente; retorna marca/config sanitizada. |
| `PUT /config/empresa`, `POST/DELETE /config/empresa/logo` | `configController` | A+SA; logo exige AD, upload `logo`, delete D; grava empresa/arquivo. Ligar `modulo_campanhas_ativo` exige perfil admin + `senha_modulo_campanhas` (env `MODULO_CAMPANHAS_SENHA`). Desligar não pede senha. |
| `GET /config/webhook-logs`, `GET /config/webhook-logs/:id`, `GET /config/auditoria` | `configController` | A+SA; filtros em query; leitura tenant-scoped. |
| `GET/POST /config/empresas-whatsapp`, `DELETE /config/empresas-whatsapp/:id` | `configController` | A+SA; legado, delete D; tabela/fallback legado pode já ter sido removido por migration. |
| `PUT /config/whatsapp/profile-picture`, `/profile-name`, `/profile-description` | `configController` | A+SA+AD+D; chama UltraMSG para perfil da instância. |
| `GET /config/permissoes/catalogo` | `permissoesController.getCatalogo` | A+SA; catálogo estático/DB. |
| `GET/PUT /config/operacional`, `GET /config/auditoria-eventos` | `configOperacionalController` | A+SA; PUT exige AD; configura/loga eventos operacionais. |
| `GET/PUT /config/alerta-sem-resposta`, `GET /config/alerta-sem-resposta/eventos`, `POST /config/alerta-sem-resposta/processar` | `atendimentoSemRespostaController` | A+SA; PUT/processar AD; processar altera alertas e pode emitir socket. |

## Clientes, tags, conversas e mensagens

`clienteRoutes` aplica `auth` ao router; `chatRoutes` explicita A por rota.

| Rotas | Controller/middleware | Entrada, resposta e efeitos relevantes |
|---|---|---|
| `GET/POST /clientes`, `GET/PUT/DELETE /clientes/:id` | `clienteController`; delete AD+D | Filtros/JSON de cliente; CRUD tenant-scoped. |
| `POST /clientes/importar/preview`, `POST /clientes/importar` | `clienteImportController`; AD, `uploadXlsx`; confirmação também D | Multipart XLSX; preview não confirma, import faz upsert/lote. Campo `vincular_alunos_mesmo_telefone` (omitido = false) grava nomes extras em `cliente_nomes_vinculados`. |
| `DELETE /clientes/todos` | `clienteController.apagarTodosClientes`; AD+D | Exclusão em massa da empresa. |
| `GET/POST /clientes/:id/tags`, `DELETE /clientes/:id/tags/:tagId` | controllers cliente | Vínculo cliente–tag. |
| `GET/POST /tags`, `PUT/DELETE /tags/:id` | `tagController` | A; mutações AD; delete D. |
| `POST /chats/contato`, `/abrir-conversa`, `/grupos`, `/comunidades` | `chatController` | A; JSON com telefone/identidade e dados específicos; cria contato/conversa/grupo via provider quando aplicável. |
| `GET /chats`, `/counts`, `/whatsapp-instances`, `/whatsapp-status`, `/zapi-status`, `/pix-config`; `PUT /chats/pix-config` | `chatController` | A; filtros/paginação; leitura/config tenant-scoped. |
| `GET/POST /chats/merge-duplicatas` | `paginaMergeDuplicatas/mergeConversasDuplicadas`; A+AD, POST D | Preview e consolidação destrutiva de conversas. |
| `POST /chats/sincronizar-contatos`, `GET /chats/debug-sync-contatos`, `POST /chats/sincronizar-fotos-perfil` | `chatController`; A | Chama UltraMSG e atualiza contatos/fotos. |
| `POST /chats/finalizacao-ausencia-lote` | `finalizacaoAusenciaLoteAuth`; A+SA | Processa lote da empresa, fecha/atualiza atendimentos. |
| `GET /chats/:id`, `GET /chats/:id/messages/search`, `GET /chats/:id/atendimentos` | `detalharChat/buscarMensagensConversa/listarAtendimentos`; A | ID + filtros/query; retorna apenas conversa acessível. |
| `GET /chats/:id/atendentes-disponiveis`, `GET/POST /chats/:id/atendentes`, `DELETE /chats/:id/atendentes/:usuario_id` | `chatController`; A | Consulta/altera participantes; socket de conversa/atribuição. |
| `POST /chats/:id/notas-internas` | `criarNotaInterna`; A | JSON texto; exige permissão granular no controller, persiste nota e emite evento. |
| `POST /chats/puxar`, `POST /chats/:id/assumir`, `/transferir` | `chatController`; A | Estado/usuário/setor no body conforme ação; atualiza fila/atendimento e sockets. |
| `POST /chats/:id/encerrar`, `/reabrir`, `/aguardando-cliente`, `/aguardando-pagamento`, `/retomar-atendimento`, `/marcar-lida-modo-simples` | `chatController`; A | Valida transição, grava conversa/atendimento/mensagens lidas e emite eventos. |
| `POST/DELETE /chats/:id/tags[/:tag_id]`, `PUT /chats/:id/departamento` | `chatController`; A | Relações e departamento; eventos tag/transferência. |
| `POST /chats/:id/mensagens`, `/pix`, `/encaminhar`, `/contatos`, `/localizacao`, `/ligacao` | `chatController`; A | JSON específico; persiste mensagem e chama UltraMSG; pode retornar erro/estado incerto. |
| `POST /chats/:id/arquivo` | `uploadArquivo`, `enviarArquivo`; A | Multipart; valida tipo/tamanho, grava mídia e chama UltraMSG. |
| `POST /chats/:id/mensagens/sync-old` | `carregarMensagensAntigasContato`; A | Aciona sincronização de histórico. |
| `DELETE /chats/:id/mensagens/:mensagem_id`, `POST/DELETE .../reacao` | `excluirMensagem/enviarReacaoMensagem/removerReacaoMensagem`; A | Chama provider quando necessário, atualiza mensagem/socket. |
| `POST .../:mensagem_id/retry-text`, `/retry-media` | `reenviarTextoMensagem/reenviarMidiaMensagem`; A | Reenvio explícito; risco de duplicidade exige conferir estado/provider. |
| `PUT /chats/:id/cliente`, `/vincular-cliente`, `/observacao`, `/nome-contato`; `PATCH /chats/:id/prefs` | `chatController`; A | `nome-contato` grava `conversas.nome_contato_cache` + `clientes.nome` (se vinculado) e emite `conversa_atualizada`. Sempre obter `io` via `req.app.get('io')` antes de emitir — variável `io` solta dá 500 depois do UPDATE. |
| `POST /chats/:id/limpar-mensagens`, `DELETE /chats/:id` | `chatController`; A+AD+D | Operações destrutivas tenant-scoped. |
| `GET /conversas/minhas-pendencias` | `minhasPendenciasController`; A | Contadores/lista do usuário autenticado. |
| `GET /print/conversas/:conversaId` | `printController`; A | Gera representação imprimível; não altera banco. |

## Dashboard, supervisão, IA, chatbot e produtos

| Rotas | Controller e acesso | Efeito |
|---|---|---|
| `GET /dashboard/overview`, `/metrics`, `/metrics-avancadas` | `dashboardController`; A+SA | Agregações tenant-scoped. |
| `GET/POST /dashboard/departamentos`, `PUT/DELETE /dashboard/departamentos/:id` | mesmo; A; mutações AD, delete D | CRUD de setores. |
| `GET/PUT /dashboard/departamentos/:id/grupos` | mesmo; A+SA | Associação setor–grupos. |
| `GET/POST /dashboard/respostas-salvas`, `PUT/DELETE .../:id` | mesmo; A; delete D | CRUD de respostas rápidas. |
| `GET /dashboard/relatorios/conversas`, `/mensagens`, `/export` | mesmo; A+SA | Query de período/filtros; export pode gerar arquivo. |
| `GET/PUT /dashboard/sla/config`, `GET /dashboard/sla/alertas`, `/resumo`, `/diaria`, `/export`, `/validacao/:conversa_id` | mesmo; A+SA; PUT AD | Configuração, cálculo e export SLA. |
| `GET /supervisao/resumo`, `/clientes-pendentes`, `/funcionarios/:usuarioId/movimentacao`, `/relatorio-diario` | `supervisaoController`; A+SA | Relatórios/monitoramento. |
| `GET/PUT /ia/config`, `GET/POST /ia/regras`, `PUT/DELETE /ia/regras/:id`, `GET /ia/logs` | `iaController`; A+SA | Config/regras automáticas e logs. |
| `POST /ia/admin-atendimento-alerta/testar` | `iaController.testarAdminAtendimentoAlerta`; A+SA | Teste lógico/alerta; conferir ambiente antes de usar. |
| `POST /ai/ask` | `aiController.ask`; A+SA+`aiLimiter` | Pergunta JSON, cota/cache/log e OpenAI se configurado. |
| `GET /chatbot/status`, `/health`, `/config/:companyId`; `POST /chatbot/configure-all`, `/configure/:companyId`, `/reconfigure/:companyId`, `/test/:companyId`; `PUT /chatbot/toggle/:companyId`, `/config/:companyId` | handlers de `chatbotManagementRoutes`; A+AD | Lê/gera/grava configuração por empresa; rotas com `companyId` validam acesso admin. |
| `GET /chatbot/debug/logs/:companyId`, `/conversation/:conversaId`, `/metrics/:companyId`, `/validate/:companyId`; `POST /chatbot/debug/simulate/:companyId`, `/reset/:companyId` | handlers de `chatbotDebugRoutes`; A+AD | Diagnóstico; simulate/reset podem gravar/apagar dados de teste da empresa. |
| `GET /produtos/consulta`, `/sync/status`; `POST /produtos/sync/wm` | `produtosController`; A no router, sync AD | PostgreSQL de produtos; sync pode ler SQL Server e transacionar no banco externo. |

## Instâncias e integração WhatsApp

Todas usam A+SA+`apiLimiter` em `whatsappIntegrationRoutes.js`; controllers recebem JSON/query e retornam dados sanitizados.

| Rotas | Controller/operação |
|---|---|
| `GET /integrations/whatsapp/me`, `/debug-config`, `/debug-status`, `/status`, `/operational-status`, `/qrcode`; `POST /restart` | Diagnóstico legado, estado/QR e reinício da instância default. |
| `GET/POST /instances`, `PATCH /instances/:id` | Listar/criar/editar instância em `whatsapp_instances`. |
| `POST /instances/:id/activate`, `/deactivate`, `/default`, `/restart`, `/configure-webhooks` | Alterar estado/default, chamar UltraMSG/reconfigurar callbacks. |
| `GET /instances/:id/status`, `GET/POST /instances/:id/qrcode` | Consulta UltraMSG; sem escrita de negócio, salvo metadados de status. |
| `POST /connect/phone-code`, `GET /connect/status`, `GET/POST /connect/qrcode`, `POST /connect/restart` | Sub-router inline `connectRouter`; conexão por telefone/QR e reinício. |
| `POST /configure-webhooks`, `/contacts/sync`, `/messages/sync-old`, `/messages/sync-old/cancel`, `/groups/sync`, `/sync-all`; `GET /messages/sync-old/status` | Configuração e sincronizações; escritas locais e chamadas externas. |
| `GET /messages`, `/messages/statistics` | Consulta de mensagens/estatísticas do provider. |

## Chat interno, help desk, push e integrações auxiliares

| Rotas | Controller/acesso | Contrato e efeito |
|---|---|---|
| `GET /internal-chat/status`, `/employees`, `/client-contacts`, `/conversations`, `/conversations/:id/messages`; `POST /internal-chat/conversations`, `.../:id/messages`, `.../:id/read`, `/forward-atendimento-message` | `internalChatController`; A | JSON/filtros; CRUD funcional, leitura e sockets internos. |
| `POST /internal-chat/conversations/:id/messages/media` | `uploadArquivo`; controller; A | Multipart, persiste mídia/mensagem e emite evento. |
| `POST /helpdesk/tickets`, `POST /helpdesk/tickets/:id/avaliacao` | `helpDeskController`; `integrationOnly` | Token+CNPJ da integração; cria/avalia ticket. |
| `GET /helpdesk/tickets`, `GET /helpdesk/tickets/:id`, `POST .../:id/messages` | mesmo; `integrationOrUser` | Aceita integração ou JWT; isolamento definido pelo autenticador. |
| `POST /helpdesk/tickets/:id/assume`, `PATCH .../:id`, `POST .../:id/transfer` | mesmo; A | Operação de atendente e sockets helpdesk. |
| `GET /helpdesk/notifications`, `POST /helpdesk/notifications/tickets/:ticketId/read`, `/read-all` | `helpDeskNotificationController`; A | Consulta/marca notificações. |
| `POST /push/tokens`, `/test-fcm`, `/tokens/logout`; `DELETE /push/tokens/logout`, `/tokens` | `fcmPushTokenController`; A | Upsert/logout e teste FCM. |
| `GET /crm/abrir-avancado` | `crmSsoController`; A | Gera handoff JWT e redireciona/retorna URL do CRM externo. |
| `POST /opt-in` | `optInOptOutController.registrarOptIn`; A+SA | Registra consentimento da empresa/contato. |
| `GET /opt-out` | `optInOptOutController.listarOptOut`; A+SA | Lista descadastros tenant-scoped; não é uma ação pública. |

## Jobs HTTP

Todos os `POST /jobs/*` abaixo passam por `jobsController.checkCronSecret`, que exige `X-Cron-Secret`; não usam JWT. Body/query selecionam lote quando suportado. Sucesso retorna resumo; segredo ausente/configuração inválida produz `401/503`; o efeito é executar a rotina correspondente.

`/jobs/timeout-inatividade`, `/timeout-inatividade-chatbot`, `/finalizacao-ausencia-cliente`, `/vencimento-pagamento-financeiro`, `/finalizacao-ausencia-lote`, `/admin-atendimento-alerta`, `/atendimento-sem-resposta`.

O mesmo router também expõe fila operacional com A+SA: `GET /jobs/` (lista por `status`), `POST /jobs/sync-contatos`, `/sync-fotos`, `/pause-all`, `/resume-all` e `POST /jobs/:id/retry`. Esses endpoints chamam `queueManager` para enfileirar, pausar, retomar ou retentar jobs da empresa. Embora o comentário do código use o termo “operacional”, `router.use(operacionalRouter)` não adiciona o prefixo `/operacional`.

## Disparo

Todas as rotas são A+AD+`requireModuloCampanhas` e tenant-scoped. Sem `empresas.modulo_campanhas_ativo` respondem 403 `MODULO_CAMPANHAS_OFF`. Uploads usam `uploadDisparoFile` ou `uploadDisparoMidia`. Controllers respondem com entidade/resumo/export ou erro de validação/estado. Mutações afetam tabelas `disparo_*`, auditoria e, durante execução, sockets/UltraMSG. A lista abaixo é completa para `routes/disparoRoutes.js` no commit/working tree analisado.

| Grupo | Rotas e controllers |
|---|---|
| Saúde/campanhas | `GET /disparo/saude` (`disparoSaudeController.obterSaude`); `GET /campanhas/resumo`, `GET/POST /campanhas`, `GET/PATCH /campanhas/:id`, `POST /campanhas/:id/arquivar`, `/restaurar` (`disparoController`). |
| Contatos/destinatários | `GET /campanhas/:id/contatos`; `GET /destinatarios/resumo`, `/nao-atribuidos`, `/destinatarios`; `POST /destinatarios/add-contatos`, `/preview` (upload), `/confirmar-importacao` (upload), `/remover-varios`; `DELETE /destinatarios`, `/destinatarios/:destId` (`disparoDestinatariosController`, salvo não atribuídos em instâncias). |
| Instâncias/distribuição | `GET /instancias/disponiveis`, `/resumo`; `POST /instancias/selecionar`, `/preview-distribuicao`, `/confirmar-distribuicao`, `/recalcular`, `/atribuir-manual`, `/mover`; `DELETE /instancias/:instanciaId` (`disparoInstanciasController`). Todos sob `/disparo/campanhas/:id`. |
| Variações | `GET/POST /variacoes`; `POST /variacoes/reordenar`, `/valores-padrao`, `/preview-distribuicao`, `/confirmar-distribuicao`, `/atribuir-manual`, `/recalcular`; `POST /variacoes/:varId/duplicar`, `/midia` (upload); `PATCH /variacoes/:varId`; `DELETE /variacoes/:varId/midia`, `/variacoes/:varId`; `GET /variacoes/variaveis`, `/variaveis/:chave/sem-valor`, `/preview/:destId`, `/resumo` (`disparoVariacoesController`; prefixo campanha). |
| Limites/agendamento | `GET /limites`, `/limites/revisao`, `/limites/conflitos`; `POST /limites`, `/limites/instancias`, `/limites/janelas`, `/limites/agendamento`, `/limites/agendamento/cancelar`, `/limites/validar`, `/limites/conflitos`, `/limites/simular`, `/limites/confirmar` (`disparoLimitesController`; prefixo campanha). |
| Revisão | `GET /revisao`, `/bloqueio`, `/historico`, `/previa`, `/exportar`; `POST /revisao/validar`, `/confirmar`, `/voltar-edicao` (`disparoRevisaoController`; prefixo campanha). |
| Execução | `POST /campanhas/:id/execucao/iniciar`, `/pausar`, `/continuar`, `/cancelar`, `/reprocessar-falhas`; `GET /campanhas/:id/execucao`, `/resumo`, `/fila`, `/eventos`, `/instancias`; `POST /disparo/execucao/emergencia`; `GET /disparo/worker/saude` (`disparoExecucaoController`). |
| Exclusões | `GET/POST /disparo/exclusoes`, `POST /exclusoes/importar`, `DELETE /exclusoes/:exclId` (`disparoExclusaoController`). |
| Opt-out/respostas/reconciliação | `GET/PUT /disparo/config/optout`; `GET /optouts`, `POST /optouts/reativar`; `GET /campanhas/:id/respostas`, `/incertos`, `/relatorio`, `/relatorio/instancias`, `/relatorio/variacoes`, `/relatorio/erros`, `/export/:tipo`; `POST /campanhas/:id/reconciliar`, `/incertos/:itemId/decisao` (`disparoEtapa8Controller`). |

## Observações de contrato

- `app.js` também adiciona CORS, Helmet, parsers, request logging e handler de erro. O middleware de erro evita enviar stack em produção.
- O status HTTP exato e todos os campos de body variam por ação; a fonte normativa é o controller acima e seus testes. Esta documentação não cria DTOs inexistentes.
- Efeitos externos são condicionais a configuração/estado. A presença de uma rota não prova funcionamento contra UltraMSG, OpenAI, FCM, SQL Server, PostgreSQL externo ou CRM em produção: isso é **PENDENTE DE VALIDAÇÃO**.

## Manifesto literal validado das rotas

Esta lista foi derivada das declarações `Router` em 2026-08-23 e serve à comparação mecânica. Os controllers, middlewares, bodies, efeitos e erros estão nas tabelas anteriores. Salvo webhooks, cada caminho também existe com `/api`; integração WhatsApp também tem alias `/integrations/zapi`, e webhook tem alias `/webhooks/whatsapp`.

### `aiRoutes.js`

`POST /ai/ask`

### `chatbotDebugRoutes.js`

`GET /chatbot/debug/logs/:companyId` · `GET /chatbot/debug/conversation/:conversaId` · `POST /chatbot/debug/simulate/:companyId` · `GET /chatbot/debug/metrics/:companyId` · `POST /chatbot/debug/reset/:companyId` · `GET /chatbot/debug/validate/:companyId`

### `chatbotManagementRoutes.js`

`GET /chatbot/status` · `POST /chatbot/configure-all` · `POST /chatbot/configure/:companyId` · `PUT /chatbot/toggle/:companyId` · `POST /chatbot/reconfigure/:companyId` · `GET /chatbot/health` · `POST /chatbot/test/:companyId` · `GET /chatbot/config/:companyId` · `PUT /chatbot/config/:companyId`

### `chatRoutes.js`

`POST /chats/contato` · `POST /chats/abrir-conversa` · `POST /chats/grupos` · `POST /chats/comunidades` · `POST /chats/finalizacao-ausencia-lote` · `GET /chats/whatsapp-instances` · `GET /chats/counts` · `GET /chats` · `GET /chats/merge-duplicatas` · `POST /chats/merge-duplicatas` · `POST /chats/sincronizar-contatos` · `GET /chats/debug-sync-contatos` · `POST /chats/sincronizar-fotos-perfil` · `GET /chats/whatsapp-status` · `GET /chats/zapi-status` · `GET /chats/pix-config` · `PUT /chats/pix-config` · `GET /chats/:id/messages/search` · `GET /chats/:id/atendentes-disponiveis` · `GET /chats/:id/atendentes` · `POST /chats/:id/atendentes` · `DELETE /chats/:id/atendentes/:usuario_id` · `POST /chats/:id/notas-internas` · `GET /chats/:id` · `POST /chats/puxar` · `POST /chats/:id/assumir` · `POST /chats/:id/encerrar` · `POST /chats/:id/reabrir` · `POST /chats/:id/marcar-lida-modo-simples` · `POST /chats/:id/aguardando-cliente` · `POST /chats/:id/aguardando-pagamento` · `POST /chats/:id/retomar-atendimento` · `POST /chats/:id/transferir` · `POST /chats/:id/tags` · `DELETE /chats/:id/tags/:tag_id` · `PUT /chats/:id/departamento` · `POST /chats/:id/arquivo` · `POST /chats/:id/mensagens/sync-old` · `POST /chats/:id/mensagens` · `POST /chats/:id/pix` · `POST /chats/:id/encaminhar` · `DELETE /chats/:id/mensagens/:mensagem_id` · `POST /chats/:id/mensagens/:mensagem_id/reacao` · `DELETE /chats/:id/mensagens/:mensagem_id/reacao` · `POST /chats/:id/mensagens/:mensagem_id/retry-text` · `POST /chats/:id/mensagens/:mensagem_id/retry-media` · `POST /chats/:id/contatos` · `POST /chats/:id/localizacao` · `POST /chats/:id/ligacao` · `PUT /chats/:id/cliente` · `PUT /chats/:id/vincular-cliente` · `PUT /chats/:id/observacao` · `PUT /chats/:id/nome-contato` · `PATCH /chats/:id/prefs` · `POST /chats/:id/limpar-mensagens` · `DELETE /chats/:id` · `GET /chats/:id/atendimentos`

### `clienteRoutes.js`

`GET /clientes` · `POST /clientes/importar/preview` · `POST /clientes/importar` · `DELETE /clientes/todos` · `GET /clientes/:id` · `GET /clientes/:id/tags` · `POST /clientes` · `PUT /clientes/:id` · `DELETE /clientes/:id` · `POST /clientes/:id/tags` · `DELETE /clientes/:id/tags/:tagId`

### `configOperacionalRoutes.js`

`GET /config/operacional` · `PUT /config/operacional` · `GET /config/auditoria-eventos` · `GET /config/alerta-sem-resposta` · `PUT /config/alerta-sem-resposta` · `GET /config/alerta-sem-resposta/eventos` · `POST /config/alerta-sem-resposta/processar`

### `configRoutes.js`

`GET /config/empresa` · `PUT /config/empresa` · `POST /config/empresa/logo` · `DELETE /config/empresa/logo` · `GET /config/webhook-logs` · `GET /config/webhook-logs/:id` · `GET /config/auditoria` · `GET /config/empresas-whatsapp` · `POST /config/empresas-whatsapp` · `DELETE /config/empresas-whatsapp/:id` · `PUT /config/whatsapp/profile-picture` · `PUT /config/whatsapp/profile-name` · `PUT /config/whatsapp/profile-description` · `GET /config/permissoes/catalogo`

### `crmSsoRoutes.js`

`GET /crm/abrir-avancado`

### `dashboardRoutes.js`

`GET /dashboard/overview` · `GET /dashboard/metrics` · `GET /dashboard/metrics-avancadas` · `GET /dashboard/departamentos` · `POST /dashboard/departamentos` · `GET /dashboard/departamentos/:id/grupos` · `PUT /dashboard/departamentos/:id/grupos` · `PUT /dashboard/departamentos/:id` · `DELETE /dashboard/departamentos/:id` · `GET /dashboard/respostas-salvas` · `POST /dashboard/respostas-salvas` · `PUT /dashboard/respostas-salvas/:id` · `DELETE /dashboard/respostas-salvas/:id` · `GET /dashboard/relatorios/conversas` · `GET /dashboard/relatorios/mensagens` · `GET /dashboard/relatorios/export` · `GET /dashboard/sla/config` · `PUT /dashboard/sla/config` · `GET /dashboard/sla/alertas` · `GET /dashboard/sla/resumo` · `GET /dashboard/sla/diaria` · `GET /dashboard/sla/export` · `GET /dashboard/sla/validacao/:conversa_id`

### `disparoRoutes.js`

`GET /disparo/saude` · `GET /disparo/campanhas/resumo` · `GET /disparo/campanhas` · `GET /disparo/campanhas/:id` · `POST /disparo/campanhas` · `PATCH /disparo/campanhas/:id` · `POST /disparo/campanhas/:id/arquivar` · `POST /disparo/campanhas/:id/restaurar` · `GET /disparo/campanhas/:id/contatos` · `GET /disparo/campanhas/:id/destinatarios/resumo` · `GET /disparo/campanhas/:id/destinatarios/nao-atribuidos` · `GET /disparo/campanhas/:id/destinatarios` · `POST /disparo/campanhas/:id/destinatarios/add-contatos` · `POST /disparo/campanhas/:id/destinatarios/preview` · `POST /disparo/campanhas/:id/destinatarios/confirmar-importacao` · `POST /disparo/campanhas/:id/destinatarios/remover-varios` · `DELETE /disparo/campanhas/:id/destinatarios` · `DELETE /disparo/campanhas/:id/destinatarios/:destId` · `GET /disparo/campanhas/:id/instancias/disponiveis` · `GET /disparo/campanhas/:id/instancias/resumo` · `POST /disparo/campanhas/:id/instancias/selecionar` · `DELETE /disparo/campanhas/:id/instancias/:instanciaId` · `POST /disparo/campanhas/:id/instancias/preview-distribuicao` · `POST /disparo/campanhas/:id/instancias/confirmar-distribuicao` · `POST /disparo/campanhas/:id/instancias/recalcular` · `POST /disparo/campanhas/:id/instancias/atribuir-manual` · `POST /disparo/campanhas/:id/instancias/mover` · `GET /disparo/campanhas/:id/variacoes` · `POST /disparo/campanhas/:id/variacoes` · `GET /disparo/campanhas/:id/variacoes/variaveis` · `GET /disparo/campanhas/:id/variacoes/variaveis/:chave/sem-valor` · `GET /disparo/campanhas/:id/variacoes/preview/:destId` · `GET /disparo/campanhas/:id/variacoes/resumo` · `POST /disparo/campanhas/:id/variacoes/reordenar` · `POST /disparo/campanhas/:id/variacoes/valores-padrao` · `POST /disparo/campanhas/:id/variacoes/preview-distribuicao` · `POST /disparo/campanhas/:id/variacoes/confirmar-distribuicao` · `POST /disparo/campanhas/:id/variacoes/atribuir-manual` · `POST /disparo/campanhas/:id/variacoes/recalcular` · `POST /disparo/campanhas/:id/variacoes/:varId/duplicar` · `POST /disparo/campanhas/:id/variacoes/:varId/midia` · `PATCH /disparo/campanhas/:id/variacoes/:varId` · `DELETE /disparo/campanhas/:id/variacoes/:varId/midia` · `DELETE /disparo/campanhas/:id/variacoes/:varId` · `GET /disparo/campanhas/:id/limites` · `GET /disparo/campanhas/:id/limites/revisao` · `GET /disparo/campanhas/:id/limites/conflitos` · `POST /disparo/campanhas/:id/limites` · `POST /disparo/campanhas/:id/limites/instancias` · `POST /disparo/campanhas/:id/limites/janelas` · `POST /disparo/campanhas/:id/limites/agendamento` · `POST /disparo/campanhas/:id/limites/agendamento/cancelar` · `POST /disparo/campanhas/:id/limites/validar` · `POST /disparo/campanhas/:id/limites/conflitos` · `POST /disparo/campanhas/:id/limites/simular` · `POST /disparo/campanhas/:id/limites/confirmar` · `GET /disparo/campanhas/:id/revisao` · `GET /disparo/campanhas/:id/revisao/bloqueio` · `GET /disparo/campanhas/:id/revisao/historico` · `GET /disparo/campanhas/:id/revisao/previa` · `GET /disparo/campanhas/:id/revisao/exportar` · `POST /disparo/campanhas/:id/revisao/validar` · `POST /disparo/campanhas/:id/revisao/confirmar` · `POST /disparo/campanhas/:id/revisao/voltar-edicao` · `POST /disparo/campanhas/:id/execucao/iniciar` · `GET /disparo/campanhas/:id/execucao` · `GET /disparo/campanhas/:id/execucao/resumo` · `GET /disparo/campanhas/:id/execucao/fila` · `GET /disparo/campanhas/:id/execucao/eventos` · `GET /disparo/campanhas/:id/execucao/instancias` · `POST /disparo/campanhas/:id/execucao/pausar` · `POST /disparo/campanhas/:id/execucao/continuar` · `POST /disparo/campanhas/:id/execucao/cancelar` · `POST /disparo/campanhas/:id/execucao/reprocessar-falhas` · `POST /disparo/execucao/emergencia` · `GET /disparo/worker/saude` · `GET /disparo/exclusoes` · `POST /disparo/exclusoes` · `POST /disparo/exclusoes/importar` · `DELETE /disparo/exclusoes/:exclId` · `GET /disparo/config/optout` · `PUT /disparo/config/optout` · `GET /disparo/optouts` · `POST /disparo/optouts/reativar` · `GET /disparo/campanhas/:id/respostas` · `GET /disparo/campanhas/:id/incertos` · `POST /disparo/campanhas/:id/reconciliar` · `POST /disparo/campanhas/:id/incertos/:itemId/decisao` · `GET /disparo/campanhas/:id/relatorio` · `GET /disparo/campanhas/:id/relatorio/instancias` · `GET /disparo/campanhas/:id/relatorio/variacoes` · `GET /disparo/campanhas/:id/relatorio/erros` · `GET /disparo/campanhas/:id/export/:tipo`

### `helpDeskRoutes.js`

`POST /helpdesk/tickets` · `GET /helpdesk/tickets` · `GET /helpdesk/tickets/:id` · `POST /helpdesk/tickets/:id/messages` · `POST /helpdesk/tickets/:id/avaliacao` · `POST /helpdesk/tickets/:id/assume` · `PATCH /helpdesk/tickets/:id` · `POST /helpdesk/tickets/:id/transfer` · `GET /helpdesk/notifications` · `POST /helpdesk/notifications/tickets/:ticketId/read` · `POST /helpdesk/notifications/read-all`

### `iaRoutes.js`

`GET /ia/config` · `PUT /ia/config` · `POST /ia/admin-atendimento-alerta/testar` · `GET /ia/regras` · `POST /ia/regras` · `PUT /ia/regras/:id` · `DELETE /ia/regras/:id` · `GET /ia/logs`

### `internalChatRoutes.js`

`GET /internal-chat/status` · `GET /internal-chat/employees` · `GET /internal-chat/client-contacts` · `POST /internal-chat/forward-atendimento-message` · `POST /internal-chat/conversations` · `GET /internal-chat/conversations` · `GET /internal-chat/conversations/:id/messages` · `POST /internal-chat/conversations/:id/messages/media` · `POST /internal-chat/conversations/:id/messages` · `POST /internal-chat/conversations/:id/read`

### `jobsRoutes.js`

`POST /jobs/timeout-inatividade` · `POST /jobs/timeout-inatividade-chatbot` · `POST /jobs/finalizacao-ausencia-cliente` · `POST /jobs/vencimento-pagamento-financeiro` · `POST /jobs/finalizacao-ausencia-lote` · `POST /jobs/admin-atendimento-alerta` · `POST /jobs/atendimento-sem-resposta` · `GET /jobs` · `POST /jobs/sync-contatos` · `POST /jobs/sync-fotos` · `POST /jobs/pause-all` · `POST /jobs/resume-all` · `POST /jobs/:id/retry`

### `mediaProxyRoutes.js`

`GET /media/proxy`

### `minhasPendenciasRoutes.js`

`GET /conversas/minhas-pendencias`

### `optInOptOutRoutes.js`

`POST /opt-in` · `GET /opt-out`

### `printRoutes.js`

`GET /print/conversas/:conversaId`

### `produtosRoutes.js`

`GET /produtos/consulta` · `GET /produtos/sync/status` · `POST /produtos/sync/wm`

### `pushRoutes.js`

`POST /push/tokens` · `POST /push/test-fcm` · `POST /push/tokens/logout` · `DELETE /push/tokens/logout` · `DELETE /push/tokens`

### `supervisaoRoutes.js`

`GET /supervisao/resumo` · `GET /supervisao/clientes-pendentes` · `GET /supervisao/funcionarios/:usuarioId/movimentacao` · `GET /supervisao/relatorio-diario`

### `tagRoutes.js`

`GET /tags` · `POST /tags` · `PUT /tags/:id` · `DELETE /tags/:id`

### `userRoutes.js`

`GET /usuarios` · `POST /usuarios/login` · `GET /usuarios/me/permissoes` · `GET /usuarios/me` · `PATCH /usuarios/me` · `GET /usuarios/push/vapid-public-key` · `POST /usuarios/me/push/subscribe` · `DELETE /usuarios/me/push/subscribe` · `POST /usuarios/me/push/test` · `POST /usuarios` · `POST /usuarios/resetar-senha-email` · `PUT /usuarios/:id` · `POST /usuarios/:id/redefinir-senha` · `DELETE /usuarios/:id` · `GET /usuarios/:id/permissoes` · `PUT /usuarios/:id/permissoes`

### `webhookUltramsgRoutes.js`

`GET /webhooks/ultramsg/health` · `GET /webhooks/ultramsg` · `POST /webhooks/ultramsg`

### `whatsappIntegrationRoutes.js`

`GET /integrations/whatsapp/me` · `GET /integrations/whatsapp/debug-config` · `GET /integrations/whatsapp/debug-status` · `GET /integrations/whatsapp/status` · `GET /integrations/whatsapp/operational-status` · `GET /integrations/whatsapp/qrcode` · `POST /integrations/whatsapp/restart` · `GET /integrations/whatsapp/instances` · `POST /integrations/whatsapp/instances` · `PATCH /integrations/whatsapp/instances/:id` · `POST /integrations/whatsapp/instances/:id/activate` · `POST /integrations/whatsapp/instances/:id/deactivate` · `POST /integrations/whatsapp/instances/:id/default` · `GET /integrations/whatsapp/instances/:id/status` · `GET /integrations/whatsapp/instances/:id/qrcode` · `POST /integrations/whatsapp/instances/:id/qrcode` · `POST /integrations/whatsapp/instances/:id/restart` · `POST /integrations/whatsapp/instances/:id/configure-webhooks` · `GET /integrations/whatsapp/connect/status` · `GET /integrations/whatsapp/connect/qrcode` · `POST /integrations/whatsapp/connect/qrcode` · `POST /integrations/whatsapp/connect/restart` · `POST /integrations/whatsapp/connect/phone-code` · `POST /integrations/whatsapp/configure-webhooks` · `POST /integrations/whatsapp/contacts/sync` · `GET /integrations/whatsapp/messages/sync-old/status` · `POST /integrations/whatsapp/messages/sync-old/cancel` · `POST /integrations/whatsapp/messages/sync-old` · `POST /integrations/whatsapp/groups/sync` · `POST /integrations/whatsapp/sync-all` · `GET /integrations/whatsapp/messages` · `GET /integrations/whatsapp/messages/statistics`
