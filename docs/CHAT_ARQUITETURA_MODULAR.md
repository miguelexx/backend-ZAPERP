# Arquitetura modular do chat (`chatController`)

> Estado **alcançado** da modularização. O documento de plano/auditoria é
> [`docs/CHAT_CONTROLLER_MODULARIZACAO.md`](CHAT_CONTROLLER_MODULARIZACAO.md); **este** descreve o que
> já existe: cada arquivo, cada função e como tudo se conecta. Leitura obrigatória antes de mexer no chat.

## 1. Visão geral

`controllers/chatController.js` deixou de ser um monolito (~10.062 linhas) e virou uma **fachada fina**
(~2.500 linhas) que:

1. importa serviços de `services/chat/**` e sub-controllers de `controllers/chat/**`;
2. **reexporta** os handlers HTTP para que `routes/chatRoutes.js` continue idêntico
   (`chatController.assumirChat`, `chatController.enviarArquivo`, …);
3. ainda hospeda inline apenas os 2 handlers P0 grandes que faltam fatiar: `listarConversas` e
   `enviarMensagemChat` (+ o trio Pix, que depende de `enviarMensagemChat`).

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
- Um **sub-controller** importa serviços; nunca importa a fachada (evita ciclo). Exceção conhecida:
  `enviarMensagemPix` fica na fachada porque **delega** a `exports.enviarMensagemChat`.
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

## 4. Ainda na fachada (inline) e por quê

- **`listarConversas`** (~1.500 linhas) — subsistema de leitura (normaliza → resolve visibilidade → query
  paginada → DTO → filtros defensivos/ordenação/prefs). Já foi extraída a derivação de filtros
  (`listarConversasFilters.js`). Próximas etapas encostam nas **queries SQL**; o doc de plano avisa que
  filtros SQL e filtros defensivos em memória formam **pares de compatibilidade — não mover separados**.
- **`enviarMensagemChat`** (~518 linhas) — P0 (ordem persistir→emitir→provider→status→reconciliar).
  Caracterizado em [`tests/enviarMensagemChat.test.js`](../tests/enviarMensagemChat.test.js) (7 testes):
  **entradas** (validação, dedup em memória, dedup persistente, permissão negada) + **respostas de envio**
  (provider ok+ID rastreável → `status:sent`+whatsapp_id; ok sem ID → `pending`; recusa → `erro`+motivo).
  Rede de segurança para extrair o `outboundMessagePipeline` (Fase 6). **Gap ainda a cobrir antes do
  refactor:** a *ordem* dos efeitos colaterais — em especial que a emissão otimista `nova_mensagem` é
  disparada (fire-and-forget) ANTES de `provider.sendText`; o doc de plano diz que essa ordem é intencional
  e não deve ser “corrigida” na extração. Os testes atuais usam `io=null` e não travam essa ordem.
- **Pix trio** (`getPixConfig`, `putPixConfig`, `enviarMensagemPix`) — `enviarMensagemPix` delega a
  `exports.enviarMensagemChat`; mover criaria ciclo. Fica na fachada por design.
- `_test` (export) e `findMensagemByClientTempId`/map agora vêm de `idempotencyService` (aliasado).

## 5. Como extrair o próximo handler (padrão comprovado)

1. **Localizar** o bloco e o `}` final por balanceamento de chaves (não por regex frágil).
2. **Checar acoplamento** a helpers inline e se o bloco **delega** a outro export da fachada (risco de ciclo).
3. **Computar imports** por análise estática dos requires do topo da fachada (destructures multi-linha).
   Atenção a: (a) `config/supabase` é **default export** (`const supabase = require(...)`, sem chaves);
   (b) imports **aliasados** (ex.: `deduplicationMap: _clientTempIdDeduplicationMap`); (c) imports que ficam
   **fora** da região do topo (ex.: `modoSimplesOutbound`).
4. **Ajustar require dinâmicos internos** de `../` para `../../` (o arquivo desce um nível para `controllers/chat/`).
5. Escrever o módulo com header + imports + bloco *verbatim*; na fachada, `const _x=require('./chat/x'); exports.h=_x.h`.
6. **Verificar:** `node --check`; carregar a **fachada completa** com env dummy (pega import faltante no load);
   rodar a suíte. Um handler não-testado pode ter identificador faltante que só quebra em runtime — revise a lista de imports.

### Armadilhas já encontradas (não repetir)
- **CommonJS não propaga reatribuição de import** → estado mutável compartilhado (flags) via getter/setter.
- **Ciclo** se um sub-controller importar a fachada (Pix). Se precisar, `require` **lazy dentro do handler**.
- **Teste que lê o código-fonte** da fachada (`fs.readFileSync('.../chatController.js')`) quebra quando o
  handler muda de arquivo — atualize o path do teste (ex.: `clientTempIdAndLegacyWebhook.test.js` aponta
  para `conversationDetailController.js`).
- Arquivos usam **CRLF**; scripts de splice devem preservar.

## 6. Cobertura de testes relevante

`tests/`: `listarConversasFilters`, `idempotencyService`, `chatProviderResultMapper`, `chatListPagination`,
`chatListCounts`, `chatSearchPrefix`, `chatMediaClassification`, `chatForwardMedia`, `chatConversaLock`
(executa transferirChat/reabrirChat — valida imports do attendance), `productionAuthorization`,
`envioManualMensagem`, `clientTempIdAndLegacyWebhook`, `atendimentoModoSimplesService`,
`whatsappOperationalPhase2_1`, `webPushDispatchService`, `chatbotTriageAntiReplay`.
Baseline atual: **178/178 verdes**. O export `_test` da fachada segue exposto para os testes de funções puras.
