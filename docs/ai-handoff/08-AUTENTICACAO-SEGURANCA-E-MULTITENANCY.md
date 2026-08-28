# Autenticação, segurança e multitenancy

> Análise estática: 2026-08-23 · `master` · `66e0771d9f61f840524cd4b0645e742df374a77a` · fontes: `middleware/`, `app.js`, `index.js`, clientes Supabase, migrations de segurança e testes de auth/isolamento/SSRF.

## JWT, usuário e autorização

Login valida senha bcrypt e `ativo`, emite JWT com usuário, empresa, perfil e departamentos; expiração vem de `JWT_EXPIRES_IN`. `middleware/auth.js` valida token e exige `company_id`, mas **não relê o usuário nem seu estado ativo a cada requisição**. Desativação/alteração de perfil não revoga imediatamente token já emitido.

Autorização predominante: `adminOnly` e `supervisorOrAdmin`. O módulo Disparo também exige `requireModuloCampanhas` (`empresas.modulo_campanhas_ativo`). Existe catálogo e overrides por usuário (`usuario_permissoes`), porém só alguns fluxos consultam permissão granular; não assumir que o catálogo protege todas as rotas. Socket repete autenticação JWT e checa acesso ao ingressar em conversa.

## Isolamento por empresa

`company_id` do JWT, instância de webhook ou token de integração deve ser aplicado em toda query. Migrations tornam tenant obrigatório nas tabelas críticas e criam índices/FKs/policies. Policies RLS usam contexto `app.company_id`, mas o cliente principal usa `SUPABASE_SERVICE_ROLE_KEY`, que ignora RLS; portanto filtros no código são a proteção primária. Nunca aceitar `company_id` de body/query para selecionar tenant.

Pontos de atenção confirmados: broadcasts na sala da empresa são mais amplos que visibilidade de setor; health da Etapa 9 consulta heartbeat global sem `company_id`; integrações help desk resolvem tenant por credencial própria. Testes `disparoIsolamentoEmpresas.test.js` e suites multiempresa exercitam mocks, não um banco RLS real.

## Proteções HTTP

- Helmet habilita headers e CSP; HSTS é aplicado em produção. `trust proxy` é configurado para o proxy esperado.
- CORS usa allowlist e padrões de origem em `helpers/corsOrigins.js` (Express e Socket.IO). Webhooks são montados antes de CORS, intencionalmente server-to-server. O handler global de erro reaplica `Access-Control-Allow-Origin` para origens permitidas, para o browser não mascarar 4xx/5xx como falha de CORS.
- JSON tem limite e captura de raw body; URL encoded limita 1 MB. Handler central sanitiza erro em produção.
- Rate limit em memória: login 20/min, webhook 3.000/min, API 30.000/min, destrutivas 300/min, IA 120/min pelos defaults do código. A descrição de webhook em `.env.example` diverge do default implementado.
- O bucket da API pode extrair claims do JWT sem verificar assinatura apenas para compor a chave; autenticação posterior continua obrigatória. Não usar isso como autorização.
- HTTPS é responsabilidade do proxy/infra; o processo Node não termina TLS. Estado real do proxy é **NÃO CONFIRMADO**.

## Webhook e cron

Webhook exige segredo compartilhado, comparação timing-safe e resolução de instância; não há HMAC. Query token é compatibilidade de maior risco. Jobs HTTP exigem `X-Cron-Secret` por comparação segura e retornam indisponível se o segredo não está configurado. Nunca registrar esses headers/valores.

## Uploads, mídia e SSRF

Uploads gerais usam nomes aleatórios, limites (32 MB não-vídeo e fonte de vídeo até 128 MB), MIME/extensão allowlist e bloqueio de extensões executáveis. A validação geral não demonstra magic bytes para todos os tipos; upload de Disparo valida assinatura de mídia e estrutura Office/ZIP. `/uploads` é público por nome; confidencialidade depende de nome não adivinhável, logo conteúdo sensível não deve ser tratado como privado.

O proxy inbound aceita HTTPS, bloqueia localhost/faixas IPv4 privadas, restringe domínios/caminhos de WhatsApp/Meta/UltraMSG e extras explícitos, revalida até três redirects e limita download. IPv6 privado e DNS rebinding não possuem mitigação explícita identificada: risco **PROVÁVEL**, ver [13](13-PROBLEMAS-CONHECIDOS-E-DIVIDA-TECNICA.md).

## Logs e segredos

`requestLogger` registra `originalUrl`. Como `/media/proxy` aceita `access_token` em query, esse token pode aparecer em logs: risco confirmado; preferir Bearer até correção. Webhook logger registra resumo por padrão e payload completo só por flag. Sanitizadores escondem tokens em respostas de instância.

Foi encontrado valor com aparência de credencial no `.env.example` preexistente e arquivos `.env`/backup ignorados em artefato local. Nenhum valor foi copiado para estes documentos. Devem ser revisados/rotacionados por responsável; estado em serviços reais é **PENDENTE DE VALIDAÇÃO**.

## Matriz de confiança

| Origem | Identidade confiável | Nunca confiar isoladamente |
|---|---|---|
| API usuário | JWT validado | `company_id`, perfil ou user id do body/query |
| Socket | JWT do handshake + consulta de acesso | sala/conversa pedida sem checagem |
| UltraMSG | token compartilhado + instância cadastrada | tenant/estado arbitrário do payload |
| Help desk integração | token+CNPJ configurados | company id enviado pelo integrador |
| Cron | `X-Cron-Secret` | IP/origem sem segredo |

## Antes de modificar segurança

Criar testes negativos com duas empresas; verificar todas as queries e rooms; preservar comparação timing-safe; não logar token/URL assinada; manter fail-fast dos segredos críticos em `index.js`; avaliar JWTs já emitidos e compatibilidade de webhooks. Testar com mocks, nunca credencial real.

