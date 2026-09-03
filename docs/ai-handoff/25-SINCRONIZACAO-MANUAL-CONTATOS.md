# Sincronização manual de contatos — análise e validação

Data: 2026-09-02. Escopo: botão **Sincronizar contatos do celular**, página Clientes.

## Falhas confirmadas no código anterior

1. O provider convertia HTTP com erro, exceções e formatos desconhecidos em agenda vazia. Um erro semântico no corpo HTTP 200 também passava despercebido.
2. `GET /contacts` recebia `limit/offset` não documentados, com inferência de próxima página pelo tamanho. A agenda inteira podia ser repetida; o fluxo completo não detectava repetição.
3. A fila retornava `ok: true` mesmo quando o serviço retornava `ok: false`, encerrando o job como concluído e emitindo sucesso.
4. A importação usava apenas a foto eventualmente incluída na lista. A função de enriquecimento individual existia, mas não era chamada no fluxo completo.
5. Locks órfãos podiam sobreviver à recuperação dos jobs; jobs longos não atualizavam seu timestamp.
6. O botão liberava novo clique logo depois de enfileirar. A tela dependia exclusivamente do evento final, confundia `message` com `mensagem` e não recuperava progresso após F5.
7. Ao detectar conexão, o backend enfileirava importação automática de agenda; a preferência antiga tinha default habilitado.
8. `extractContactFromResponse` estava dentro de comentário aberto. A consulta de metadados caía no catch e em consultas de fallback.
9. `strictAgendaImport` restringia a lista inicial de telefones, mas o helper de busca voltava a adicionar variantes e sufixos, permitindo misturar telefones diferentes.

Esses defeitos foram reproduzidos/analisados localmente. Não foi identificado qual deles ocorreu na instância de produção do usuário, pois não houve consulta à agenda real nem aos logs remotos nesta tarefa.

## Comportamento implementado

- O clique chama `POST /chats/sincronizar-contatos`; o alias de Integrações usa o mesmo controller. A empresa vem exclusivamente do JWT.
- HTTP 202 informa o job; requisições simultâneas compartilham o mesmo enqueue no processo suportado. A fila impede reimportação concorrente com lock de empresa/tipo.
- O job manual ignora a pausa operacional apenas para essa importação. Não chama `resumeAll`, nem libera outros processos da empresa. Falha de contatos não pausa globalmente a empresa.
- O provider lê a lista inteira de `/contacts`, sem paginação fictícia. Aceita envelopes de lista conhecidos e nomes salvos alternativos; rejeita grupos, broadcasts, LID sem telefone resolvido e registros explicitamente não salvos.
- O serviço percorre todos os contatos válidos, sem teto de 1.000/10.000 itens; não importa apenas clientes/conversas já existentes. Eventual provider paginado tem proteção explícita contra repetição/limite, reportada como erro.
- Cada contato usa o JID exato para buscar a foto em `/contacts/image` se a lista não contém uma URL. O rate limit existente do provider controla essas chamadas.
- Atualiza fotos disponíveis, preserva fotos quando a API não fornece substituição e preserva nomes protegidos. Identidade de importação é telefone exato com DDI, inclusive internacional.
- Jobs e locks recebem heartbeat a cada 30 segundos; a fila revisita jobs travados a cada minuto. Locks antigos usam limite de 10 minutos. A arquitetura continua sendo PM2 fork, um processo.
- Erros de API, leitura/gravação e importação incompleta chegam ao resultado do job. Há retry com backoff já existente; falha final vira `dead_letter`, sem evento falso de sucesso.
- O evento legado `zapi_sync_contatos` permanece, com `tipo`, `job_id`, `running`, contadores e erro. Progresso é publicado a cada 10 contatos e persistido no checkpoint, vinculado ao job.
- `GET /chats/sincronizar-contatos/status?job_id=...` é somente leitura, exige autenticação e filtra empresa + tipo + job. Recupera progresso mesmo sem Socket.IO.
- A página consulta progresso a cada 3 segundos enquanto ativo, atualiza a lista sem desmontar a seção e mantém a pesquisa. O botão permanece desabilitado até terminar. Abrir a página/F5 não cria job.
- A importação de agenda ao conectar foi removida, inclusive para empresas com preferência antiga true. A sincronização de grupos/chats já existente permanece separada.

## Verificação executada

**119 testes Jest passaram em 10 suites**, com Supabase/UltraMSG simulados. Incluem 1.005 contatos persistidos com fotos, segunda execução sem duplicatas, identidade internacional, falhas de leitura/update/insert, locks antigos/recentes, empresas isoladas, clique simultâneo, erro da fila, recuperação por HTTP e conexão sem importar agenda. Também foram executadas regressões de nomes protegidos, fotos, importação por planilha, identidade WhatsApp, provider e mensagens antigas.

**4 testes Playwright passaram**, desktop e celular: inicia exclusivamente por clique, mostra nomes/foto, acompanha sem Socket.IO, recupera após F5, desbloqueia ao concluir e mostra erro sem falso sucesso.

**Build Vite concluído**. Há aviso de CSS preexistente com aspas tipográficas em `url(“data:...)`, fora do escopo desta alteração.

Suites novas: `manualContactSync.test.js`, `manualContactSyncQueue.test.js`, `ultramsgAgenda.test.js`; navegador: `frontend/e2e/manual-contact-sync.spec.js`.

## Causa-raiz do "não puxa NENHUM contato" (400 em produção) — corrigido 2026-09-02

Sintoma: clicar em **Sincronizar contatos do celular** mostrava *"Configure a instância WhatsApp em Integrações antes de sincronizar."* e o console registrava `POST /chats/sincronizar-contatos → 400`. Mensagens (enviar/receber) funcionavam normalmente.

Diagnóstico: a mensagem 400 vem de `sincronizarContatosZapi` (`controllers/chat/integrationController.js`) quando `getEmpresaWhatsappConfig` falha. Essa função — e todo o worker (`runContactSyncFull`) — resolve credenciais por `getDefaultWhatsappInstance(company_id)`. Em produção (`NODE_ENV=production`, ver `ecosystem.config.js`), essa resolução **exigia uma linha `whatsapp_instances` com `is_default=true`** e **não** caía para "primeira ativa" nem para o legado `empresa_zapi`. O envio de mensagens continuava funcionando porque usa a instância **explícita** da conversa (`conversas.whatsapp_instance_id` → `getWhatsappInstanceById`), que ignora `is_default`. Resultado: empresa migrada para `whatsapp_instances` sem um default marcado → envio OK, mas sync/fotos/nova-conversa quebravam com 400.

Correção (`services/whatsappInstanceService.js`, sem migration): quando não há linha `is_default`, a resolução default agora:
- **exatamente 1 instância ativa** → adota-a (inclusive em produção); single-instance não tem ambiguidade e filtra por `company_id`, sem risco cross-tenant;
- **2+ ativas sem default** → mantém a exigência de escolha explícita em produção (`NO_DEFAULT_INSTANCE`) — invariante multi-tenant preservada;
- **0 ativas / tabela ausente** → cai para o legado `empresa_zapi` (linha única via `maybeSingle`), inclusive em produção.
Mesma relaxação aplicada a `resolveWhatsappInstanceForManualAction` (Novo cliente / abrir conversa) para o caso de instância única. Testes atualizados em `tests/whatsappInstanceService.test.js` (single→adota, multi→recusa, 0→legado).

Alternativa sem código (se preferir manter a rigidez): marcar a instância única como default via RPC `set_default_whatsapp_instance` / `setDefaultWhatsappInstance`. A correção de código evita depender disso e torna o single-instance robusto.

## Parar a importação no meio (cancelamento) — 2026-09-02

Com agendas grandes (ex.: 5021 contatos) o usuário precisa poder abortar. Reusa a infra de cancelamento existente (`requestCancelJob` / `isJobCancelRequested` — mesma usada por `sync_mensagens_antigas`).

- Endpoint: `POST /chats/sincronizar-contatos/cancelar` → `cancelarSincronizacaoContatos` → `requestCancelJob(company_id, SYNC_CONTATOS)`. Job `pending` cancela na hora; `running` vira `cancel_requested`.
- Worker (`runContactSyncFull`): recebe `opts.shouldCancel` (via `executeJob`) e checa antes de cada página da agenda e a cada ~10 contatos no laço de importação. Ao cancelar, retorna `{ ok: true, cancelled: true, aviso: 'Importação interrompida…' }` — **os contatos já gravados são mantidos**, o lock é liberado no `finally`, e `finalizeJob` marca o job como `cancelled` (não falha, não re-tenta).
- Progresso/estado: `contactSyncStatus` agora expõe `cancelado`/`cancelando`; a emissão de conclusão usa status `cancelled` quando aplicável.
- Frontend: hook `useContactSync` expõe `cancelar()` + estado `cancelling`; `ClientesSection` mostra o botão **Parar importação** (vermelho) enquanto sincroniza e o texto "Interrompendo…/Importação interrompida".
- Testes: `tests/manualContactSync.test.js` cobre cancelar-antes-de-buscar (0 importados, lock liberado) e parar-no-meio (parcial preservado).

## Teto de 2500 contatos + nome e foto — 2026-09-02

- `runContactSyncFull` aplica teto de **2500 contatos** por sincronização (`MAX_CONTATOS_DEFAULT`, override via env `SYNC_MAX_CONTATOS` ou `opts.maxContatos`). Ao atingir, para de acumular na deduplicação (`truncadoPorLimite=true`) e o `aviso` orienta rodar de novo para o restante. O resultado expõe `truncadoPorLimite` e `limiteContatos`.
- **Nome:** `parseAgendaContact` exige `name` não vazio — só entra contato salvo com nome.
- **Foto:** `syncOneAgendaContact({ includePhotos: true })` usa a foto da lista (`imgUrl/photo/profilePicture`) e, quando ausente, busca por contato via `provider.getProfilePicture(jid)`. O endpoint enfileira com `includePhotos: true`. Contato sem foto no provedor entra só com nome (`totalFotosIndisponiveis`), sem sobrescrever foto existente.
- Testes: teto (importa N=limite, avisa truncamento, nome+foto preservados) e os 1005-com-foto cobrindo o caminho de foto.

## Infraestrutura e limites de certificação

Não exige migration nem nova variável. Reutiliza `jobs`, `checkpoints_sync` e `sync_locks`. Backend e frontend precisam ser publicados juntos para o endpoint de progresso existir. Nenhum commit, push, deploy ou sincronização de agenda real foi executado nesta tarefa.

O sistema importa a agenda disponibilizada pelo WhatsApp/UltraMSG. Ele não tem acesso direto à agenda nativa Android/iOS e não pode fabricar nomes ou fotos que o provider não disponibilize. Contatos sem foto recebem aviso de indisponibilidade; a validação local não comprova que a instância real oferece todos os registros do celular.

Após publicação, a verificação real depende do clique do usuário, conforme solicitado: conferir contador, amostras de nomes/fotos e o resultado final. Eventual divergência deve ser diagnosticada pela resposta de `/contacts` da instância correta e estado do job, sem registrar token ou agenda completa em logs.

Referências oficiais consultadas: [lista de contatos](https://docs.ultramsg.com/api/get/contacts), [informações do contato](https://docs.ultramsg.com/api/get/contacts/contact), [foto do contato](https://docs.ultramsg.com/api/get/contacts/image).
