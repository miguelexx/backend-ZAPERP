# Arquitetura modular do chat (`chatController`)

> Estado **alcançado** da modularização. Mapa de extração: [`ai-handoff/23-CHAT-CONTROLLER-MODULARIZACAO.md`](ai-handoff/23-CHAT-CONTROLLER-MODULARIZACAO.md).
> Este arquivo descreve o que já existe: cada arquivo, cada função e como tudo se conecta. Leitura obrigatória antes de mexer no chat.

## 1. Visão geral

`controllers/chatController.js` deixou de ser um monolito (~10.062 linhas) e virou um **shim fino**
(~442 linhas) que:

1. importa serviços de `services/chat/**` e sub-controllers de `controllers/chat/**`;
2. **reexporta** todos os handlers HTTP para que `routes/chatRoutes.js` continue idêntico
   (`chatController.assumirChat`, `chatController.enviarArquivo`, …);
3. reexporta 6 helpers de realtime/visibilidade (contrato legado) e mantém `exports._test`;
4. **não hospeda mais nenhum handler nem helper inline** — todos foram para `controllers/chat/**` ou `services/chat/**`.

**Regra de ouro:** rotas e contratos HTTP/realtime NÃO mudaram. Toda extração foi *verbatim* (mesmo
código), só reorganizada. Se um comportamento parece “errado”, ele provavelmente é intencional —
confira o git/original antes de “consertar”.

### Direção de dependência (nunca inverter)

```
routes/chatRoutes.js
      ↓
controllers/chatController.js (fachada)  ──reexporta──>  controllers/chat/*.js (sub-controllers HTTP)
      ↓                                                        ↓
                          services/chat/**  (regras, adaptadores, gateway, DTOs)
      ↓
config/supabase · helpers/** · services/** (não-chat)
```

- Um **serviço** (`services/chat/**`) nunca importa um controller nem a fachada.
- Um **sub-controller** importa serviços; nunca importa a fachada (evita ciclo). Um sub-controller pode
  importar **outro sub-controller sibling** quando delega (ex.: `pixController` → `textMessageController`
  para `enviarMensagemPix`), desde que a direção seja acíclica.
- `realtime` depende de `access` (visibilidade) — nunca o contrário.

## 2. `services/chat/**` — módulos e funções

### access/ (autorização e visibilidade)
- **`conversationPolicy.js`** — política canônica de acesso.
  - `assertPermissaoConversa({company_id,conversa_id,user_id,role,user_dep_ids})` → quem pode **ver**
    (admin/supervisor/atendente, responsável, participante ativo, quem transferiu, encerrada, grupo por setor).
  - `assertPodeEnviarMensagem({...,autoAssumirAoEnviar,io})` → quem pode **enviar** (+ auto-assumir no 1º envio; modo simples).
  - `podeAssumirConversaPorPerfil(role)`.
- **`conversationVisibilityService.js`** — visibilidade + cache (TTL 15s, local ao processo) + unread por setor.
  - `obterUsuarioIdsQuePodemVerConversa`, `carregarUsuarioIdsQuePodemVerConversaSemCache`,
    `invalidateConversaVisibilityCache`, `incrementarUnreadParaConversa`,
    `getConversaParticipanteIdsAtivos`, `getConversaIdsParticipanteAtivo`, `usuarioParticipaAtivamenteDaConversa`,
    `isConversaAtendentesMissingTable`, `payloadAlteraVisibilidadeConversa`, `deveIncluirGruposSemDepartamentoNoFiltroTodos`.

### identity/
- **`conversationAddressService.js`** — endereço de destino (resolve LID→telefone e instância).
  - `resolveConversationWhatsappInstance`, `resolverTelefoneEnvioDaConversa`, `resolveTelefoneFromLidSiblingConversation`.

### realtime/
- **`chatRealtimeGateway.js`** — emissão Socket.IO (rooms empresa/conversa/usuário/departamento), respeitando visibilidade + web push.
  - `emitirConversaAtualizada`, `emitirEventoConversaVisivel`, `emitirEventoEmpresaConversa`,
    `emitirParaUsuariosQuePodemVerConversa`, `emitirSincronizacaoListaConversas`, `emitirLock`,
    `emitirRealtimeAposAssumir`, `emitirParaUsuario`, `emitirMovimentacaoInternaAtendimento`, `emitirDepartamento`.

### read/ (leitura/paginação/busca)
- **`pagination.js`** (puro) — `parseChatListPagination`, `splitChatListPage`, `applyChatListCursor`,
  `parseMessageHistoryPagination`, `splitMessageHistoryPage`, `shouldIncludeClientesSemConversa`,
  `setChatListPaginationHeaders`, `applyDetalharChatMensagensCursor`, `parsePositiveInt`, `parseBooleanQuery`.
- **`searchLimits.js`** (puro, lê env) — `getSearchMessagesPageSize`, `getChatSearchScanLimit`,
  `getChatSearchIdLimit`, `getChatFilterIdLimit`, `getConversaMessagesSearchLimit`.
- **`listarConversasFilters.js`** (puro) — `deriveListarConversasFilters(query)` deriva TODAS as flags de
  `GET /chats` (busca desliga chips de estado; valida `atendente_id`). `TEMPO_PARADO_HORAS`.
- **`conversationLookups.js`** — `loadWhatsappInstanceMetaMap`, `resolveUltraMsgReplyMessageId`,
  `buscarConversaIdsPorTextoMensagens`.

### presentation/ (DTOs)
- **`chatDto.js`** (puro) — `mergeConversaClienteTags`, `statusAtendimentoParaLista` (expõe `ociosa`), `safeWhatsappInstanceMeta`.
- **`messageAuthorEnrichment.js`** — `enrichMensagensComAutorUsuario`, `enrichMensagemComAutorUsuario`,
  `aplicarApagadaParaTodosNaMensagem`, `textoRevogadoApagadaParaTodos`, `textoParaEnvioWhatsapp`,
  `prefixarParaCliente`, `getUsuarioParaEnvioCliente`. (as que tocam banco recebem `supabase` por parâmetro.)

### unread/
- **`conversationUnreadService.js`** — `marcarComoLidaPorUsuario`, `obterUnreadMap`.

### media/
- **`mediaType.js`** (puro) — classificação e decisões: `inferirTipoArquivo`, `mimeBase`, `extBaseArquivo`,
  `aplicarTipoForcadoSticker`, `isForcedVoiceAudioish`, `shouldNormalizeVideoForUltraMsg`,
  `shouldNormalizeImageForWhatsapp`, `shouldAbortAudioAfterNormalize`, `shouldForceProviderUploadForMedia`,
  `buildVideoTranscodeProfile`, `parseAudioDuracaoSecFromBody`, `getAudioFileExtension` + constantes de extensão/limites.
- **`mediaNormalizers.js`** — FFmpeg/filesystem (I/O): `normalizeAudioForUltraMsg`, `normalizeVideoForUltraMsg`,
  `normalizeImageForWhatsapp`, `convertAudioWithFfmpeg`, `convertVideoToUltraMsgMp4`, `convertImageToWhatsappJpeg`,
  `probeAudioDurationSec`, `probeVideoDurationSec`, `resolveFfmpegPath`.

### outbound/ (saída de mensagens)
- **`providerResultMapper.js`** (puro) — `mapProviderSendResult(result,opts)` → `sent/pending/erro` +
  `whatsapp_id`/`provider_queue_id`. **Adapter pronto; endpoints ainda NÃO migrados** (Fase 6). Preserva a
  divergência: texto grava `status_mensagem='failed'` em falha, os demais gravam `'erro'` (parâmetro `failedStatusMensagem`).
- **`retryEligibility.js`** (puro) — `avaliarElegibilidadeReenvio`, `statusReenvioNormalizado`, `captionUsuarioDeMidiaPersistida`.
- **`idempotencyHelpers.js`** (puro) — `normalizeClientTempId`, `clientTempIdDedupeKey`, `buildClientTempIdDedupResponse`,
  `isClientTempIdUniqueViolation`, `isMissingMensagemColumnError`, `isGenericMissingColumnError`.
- **`idempotencyService.js`** — **estado de processo**: `deduplicationMap` (Map, TTL 30s/limpeza 5min),
  `findMensagemByClientTempId`, e flags-latch via getter/setter (`isDbDedupeUnavailable`/`markDbDedupeUnavailable`,
  `isAudioDuracaoSecColumnUnavailable`/`markAudioDuracaoSecColumnUnavailable`). **Getter/setter porque CommonJS não
  propaga reatribuição de binding importado** — nunca troque por `let` importado.
- **`modoSimplesOutbound.js`** — `aplicarAguardandoClienteNoPayload`, `recalcularEMesclarModoSimples`.
- **`messageNormalizers.js`** (puro) — `normalizeLinkPayload`, `normalizeForwardTipo`.
- **`forwardMediaResolver.js`** — `resolveForwardMediaForProvider` (+ `getForwardMediaUrlCandidate`,
  `resolveLocalUploadPathFromMediaUrl`, `downloadR2MediaToTemp`, `safeDecodeURIComponent`).
- **`pixConfig.js`** (puro) — `sanitizePixConfigPayload`, `buildPixMessageFromConfig`, `formatPixTipoLabel`.

## 3. `controllers/chat/**` — sub-controllers (handlers HTTP)

Cada arquivo abaixo é reexportado pela fachada. Rota exata: ver `routes/chatRoutes.js`.

| Arquivo | Handlers |
|---|---|
| `attendanceController.js` | assumirChat, encerrarChat, reabrirChat, marcarLidaModoSimplesChat, marcarAguardandoClienteManualChat, marcarAguardandoPagamentoFinanceiroChat, retomarEmAtendimentoManualChat, transferirChat, transferirSetor, listarAtendentesDisponiveisConversa, criarNotaInterna, removerAtendenteConversa, listarAtendentesConversa, adicionarAtendenteConversa |
| `attendanceQueueController.js` | listarAtendimentos, puxarChatFila |
| `contactController.js` | criarGrupo, criarComunidade, vincularClienteConversa, atualizarNomeContato, atualizarObservacao, abrirConversaCliente, criarContato |
| `outboundController.js` | enviarReacaoMensagem, removerReacaoMensagem, enviarContatoWhatsapp, enviarLocalizacao, enviarLigacaoWhatsapp |
| `mediaMessageController.js` | enviarArquivo (+ helpers internos enviarArquivoProcessarUm, dedupeMulterFiles) |
| `retryController.js` | reenviarTextoMensagem, reenviarMidiaMensagem (+ lock `_reenviosEmAndamento`) |
| `forwardController.js` | encaminharMensagem (+ encaminharUmaMensagemParaConversa, collectOrderedMessageIds) |
| `conversationDetailController.js` | detalharChat (+ ordenarMensagensHistoricoAsc) |
| `messageReadController.js` | carregarMensagensAntigasContato, buscarMensagensConversa |
| `messageDeletionController.js` | excluirMensagem |
| `conversationCleanupController.js` | limparMensagensConversa, apagarConversa |
| `maintenanceController.js` | paginaMergeDuplicatas, mergeConversasDuplicadas (+ HTML embutido) |
| `integrationController.js` | listWhatsappInstancesAtendimento, whatsappStatus, **zapiStatus (alias legado = whatsappStatus)**, sincronizarContatosZapi, debugSyncContatos, sincronizarFotosPerfilZapi |
| `tagsController.js` | adicionarTagConversa, removerTagConversa |
| `preferencesController.js` | patchConversaPrefs |
| `batchOpsController.js` | contarConversasPorFiltros, finalizacaoAusenciaLoteAuth |
| `conversationListController.js` | **listarConversas** (GET /chats — o maior handler, ~1.412 linhas) |
| `textMessageController.js` | **enviarMensagemChat** (texto/link — fluxo P0 de envio) |
| `pixController.js` | getPixConfig, putPixConfig, enviarMensagemPix (delega a `textMessageController.enviarMensagemChat`) |

## 4. Trabalho restante (agora é decomposição INTERNA, não mais extração da fachada)

A fachada já é shim. O que resta é **fatiar por dentro** os 2 handlers grandes, que hoje moram em arquivos
próprios (`conversationListController.js` e `textMessageController.js`). Isso é opcional e mais arriscado
que as realocações verbatim feitas até aqui — exige testes de caracterização antes.

- **`conversationListController.js` / `listarConversas`** (~1.412 linhas) — subsistema de leitura
  (normaliza → resolve visibilidade → query paginada → DTO → filtros defensivos/ordenação/prefs). Já foi
  extraída a derivação de filtros (`listarConversasFilters.js`). As próximas etapas encostam nas **queries
  SQL**; o doc de plano avisa que filtros SQL e filtros defensivos em memória formam **pares de
  compatibilidade — não mover separados**. Próxima parte pura segura: transformação linha→DTO.
- **`textMessageController.js` / `enviarMensagemChat`** (~518 linhas) — P0 (ordem persistir→emitir→provider→status→reconciliar).
  Caracterizado em [`tests/enviarMensagemChat.test.js`](../tests/enviarMensagemChat.test.js) (7 testes):
  **entradas** (validação, dedup em memória, dedup persistente, permissão negada) + **respostas de envio**
  (provider ok+ID rastreável → `status:sent`+whatsapp_id; ok sem ID → `pending`; recusa → `erro`+motivo).
  Rede de segurança para extrair o `outboundMessagePipeline` (Fase 6). **Gap ainda a cobrir antes do
  refactor:** a *ordem* dos efeitos colaterais — em especial que a emissão otimista `nova_mensagem` é
  disparada (fire-and-forget) ANTES de `provider.sendText`; o doc de plano diz que essa ordem é intencional
  e não deve ser “corrigida” na extração. Os testes atuais usam `io=null` e não travam essa ordem.
- **Pix** (`pixController.js`) — `enviarMensagemPix` monta o texto e chama
  `require('./textMessageController').enviarMensagemChat(req,res)` (import direto de sibling, sem ciclo:
  `pixController → textMessageController`, nunca o inverso).
- `exports._test` continua na fachada (contrato dos testes de funções puras); `findMensagemByClientTempId`
  e o Map de dedup vêm de `idempotencyService` (import **aliasado** `deduplicationMap: _clientTempIdDeduplicationMap`).

## 5. Extração da fachada — **concluída**

Não há handler HTTP restante em `chatController.js`. O padrão abaixo vale só se surgir um bloco **ainda inline** (não é o caso de lista/texto/PIX).

1. **Localizar** o bloco e o `}` final por balanceamento de chaves (não por regex frágil).
2. **Checar acoplamento** a helpers inline e se o bloco **delega** a outro export (risco de ciclo).
3. **Computar imports** por análise estática. Atenção a: (a) `config/supabase` é **default export**;
   (b) imports **aliasados** (ex.: `deduplicationMap: _clientTempIdDeduplicationMap`); (c) imports fora do topo.
4. **Ajustar require** de `../` para `../../` ao descer para `controllers/chat/`.
5. Módulo com header + imports + bloco *verbatim*; na fachada, `const _x=require('./chat/x'); exports.h=_x.h`.
6. **Verificar:** `node --check`; carregar a fachada com env dummy; suíte `chat*`.

### Armadilhas já encontradas (não repetir)
- **CommonJS não propaga reatribuição de import** → estado mutável compartilhado (flags) via getter/setter.
- **Ciclo** se um sub-controller importar a fachada. Pix **não** faz isso: `pixController` importa `./textMessageController` (sibling), nunca o inverso.
- **Teste que lê o código-fonte** da fachada (`fs.readFileSync('.../chatController.js')`) quebra quando o
  handler muda de arquivo — atualize o path (ex.: `clientTempIdAndLegacyWebhook.test.js` → `conversationDetailController.js`).
- Arquivos usam **CRLF**; scripts de splice devem preservar.
- **Não reextrair** lista/texto/PIX: em 2026-09-01 podem estar só no working tree (`conversationListController.js`, `textMessageController.js`, `pixController.js`).

## 6. Cobertura de testes relevante

`tests/`: `listarConversasFilters`, `idempotencyService`, `chatProviderResultMapper`, `chatListPagination`,
`chatListCounts`, `chatSearchPrefix`, `chatMediaClassification`, `chatForwardMedia`, `chatConversaLock`
(executa transferirChat/reabrirChat — valida imports do attendance), `productionAuthorization`,
`envioManualMensagem`, `clientTempIdAndLegacyWebhook`, `atendimentoModoSimplesService`,
`whatsappOperationalPhase2_1`, `webPushDispatchService`, `chatbotTriageAntiReplay`.
Baseline na extração lista/texto/PIX: **185/185** (não reler 178). Inclui `enviarMensagemChat.test.js`. O export `_test` da fachada segue exposto para testes de funções puras.
