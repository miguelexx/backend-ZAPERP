# Auditoria e plano de modularização do `chatController.js`

> **Histórico.** Snapshot do monolito (~10.062 linhas) **antes** da quebra.  
> Estado real no código e próximos passos: [`ai-handoff/23-CHAT-CONTROLLER-MODULARIZACAO.md`](ai-handoff/23-CHAT-CONTROLLER-MODULARIZACAO.md).  
> Não usar as contagens/linhas deste arquivo como mapa do `chatController.js` atual.

## 1. Objetivo e limite da auditoria

Este documento **descrevia** o estado do monolito na data da auditoria e propunha uma modularização incremental. A quebra **já ocorreu**; não usar as seções abaixo como mapa do arquivo atual.

O escopo da análise foi deliberadamente limitado ao conteúdo desse arquivo. Rotas, middlewares, migrations, testes e implementações dos serviços importados não foram auditados. Quando uma garantia parece depender dessas camadas — por exemplo, “admin only” — ela é registrada como dependência externa não verificada, e não como garantia confirmada.

Esta sessão não implementa a modularização. O único artefato produzido é esta documentação.

## 2. Resumo executivo

O arquivo atual funciona simultaneamente como:

- controller HTTP;
- camada de autorização por conversa, setor, perfil e participante;
- orquestrador de casos de uso;
- repositório Supabase;
- adaptador do provider WhatsApp;
- dispatcher de eventos Socket.IO e web push;
- formatador de DTOs da lista e do detalhe;
- motor de busca, filtros e paginação;
- pipeline de envio e reconciliação de mensagens;
- pipeline de upload, conversão e encaminhamento de mídia;
- compatibilidade com schemas em diferentes estágios de rollout;
- manutenção administrativa e diagnóstico;
- armazenamento de caches, locks e deduplicação em memória.

Indicadores do snapshot auditado:

| Indicador | Valor observado |
|---|---:|
| Linhas | 10.062 |
| Funções nomeadas no nível do módulo | 108 |
| Atribuições a `exports.*` | 63 |
| Chamadas a `require(...)` | 83 |
| Tabelas referenciadas diretamente | 19 |
| Blocos `catch` | 115 |
| `catch` vazios | 19 |
| Maior endpoint | `listarConversas`, 1.632 linhas |
| Maior fluxo de texto | `enviarMensagemChat`, 524 linhas |
| Processamento unitário de arquivo | `enviarArquivoProcessarUm`, 485 linhas |
| Detalhe do chat | `detalharChat`, 365 linhas |

Os números são métricas estruturais; não significam isoladamente defeitos. Eles mostram, contudo, que qualquer alteração transversal exige compreender muitos contratos implícitos ao mesmo tempo.

## 3. Diagnóstico arquitetural

### 3.1. Responsabilidades encontradas

1. **Leitura de conversas** — filtros, busca, paginação, contagens, enriquecimento, ordenação, clientes sem conversa e preferências.
2. **Leitura de mensagens** — histórico paginado, busca textual, mensagens ocultas, movimentações internas e enriquecimento de autor.
3. **Acesso e visibilidade** — tenant, setor, grupo, responsável principal, co-atendentes, transferências anteriores e conversa encerrada.
4. **Realtime** — rooms por empresa, conversa, usuário e departamento; invalidação de cache; locks; sincronização da lista; web push.
5. **Ciclo de atendimento** — assumir, encerrar, reabrir, puxar da fila, transferir usuário/setor e estados manuais.
6. **Colaboração** — notas internas e participantes adicionais.
7. **Contatos e identidade** — LID, telefone real, vínculo com cliente, nomes, observações, grupos, comunidades e instâncias WhatsApp.
8. **Saída de mensagens** — texto, link, Pix, reação, contato, localização, ligação, mídia, encaminhamento e reenvio.
9. **Mídia** — classificação, segurança de extensão, FFmpeg, duração, normalização, upload para provider, R2 e limpeza de temporários.
10. **Manutenção** — merge de duplicatas, limpeza/exclusão, sincronizações e diagnóstico.
11. **Compatibilidade de rollout** — fallbacks para colunas/tabelas ausentes e aliases legados como `zapiStatus`.

### 3.2. Dependências diretas

O controller acessa diretamente as tabelas:

`atendimentos`, `avaliacoes_atendimento`, `bot_logs`, `clientes`, `conversa_atendentes`, `conversa_tags`, `conversa_unreads`, `conversa_usuario_prefs`, `conversas`, `departamentos`, `empresa_pix_config`, `empresas`, `empresas_whatsapp`, `historico_atendimentos`, `mensagens`, `mensagens_ocultas`, `usuario_departamentos`, `usuarios` e `whatsapp_instances`.

Também combina serviços de atendimento, instâncias WhatsApp, sincronização, busca, contagem, ausência, modo simples, permissões, notificações, R2 e provider. Há imports no topo e imports dinâmicos no meio dos fluxos. Essa mistura dificulta identificar dependências obrigatórias de cada caso de uso e favorece ciclos quando a extração começar.

### 3.3. Estado de processo

Há três grupos de estado em memória:

- `_clientTempIdDeduplicationMap`, com limpeza por `setInterval` iniciado no carregamento do módulo;
- flags `_clientTempIdDbDedupeUnavailable` e `_audioDuracaoSecColumnUnavailable`;
- `conversaVisibilityCache` e promessas de carregamento;
- `_reenviosEmAndamento`, usado como lock local de reenvio.

Esse estado é local ao processo. Em execução com múltiplas instâncias, deduplicação, cache e locks não são compartilhados. A deduplicação de texto/mídia possui defesa persistente quando a coluna existe; o lock de reenvio permanece apenas local. A modularização deve tornar essa semântica explícita antes de considerar qualquer mudança de infraestrutura.

## 4. Inventário funcional e fronteiras naturais

### 4.1. Infraestrutura compartilhada, linhas 104–1464

| Bloco | Responsabilidade atual | Destino sugerido |
|---|---|---|
| Tags e DTOs | `mergeConversaClienteTags`, status de lista e metadados de instância | `chat/presentation/chatDto.js` |
| Deduplicação | normalização de `client_temp_id`, consulta persistente e respostas deduplicadas | `chat/outbound/idempotencyService.js` |
| Identidade WhatsApp | resolução de LID, telefone e instância | `chat/identity/conversationAddressService.js` |
| Paginação | parsers, cursores, split de páginas e headers | `chat/read/pagination.js` |
| Realtime | emissão, locks, lista, autor e movimentações | `chat/realtime/chatRealtimeGateway.js` |
| Autorização | `assertPermissaoConversa`, `assertPodeEnviarMensagem` e participação | `chat/access/conversationPolicy.js` |
| Unread | leitura, limpeza e incremento | `chat/unread/conversationUnreadService.js` |
| Visibilidade | destinatários, cache e invalidação | `chat/access/conversationVisibilityService.js` |
| Busca interna | limites e busca em texto de mensagens | `chat/read/conversationSearchService.js` |

Esses blocos devem ser extraídos antes dos endpoints que os consomem. Realtime depende de visibilidade; envio depende de autorização, identidade e realtime. A direção inversa deve ser proibida para evitar ciclos.

Seis helpers dessa região também fazem parte da superfície exportada do módulo e precisam continuar reexportados pela fachada durante a migração:

| Export compartilhado | Linha atual | Destino sugerido |
|---|---:|---|
| `emitirEventoEmpresaConversa` | 700 | `chat/realtime/chatRealtimeGateway.js` |
| `emitirRealtimeAposAssumir` | 732 | `chat/realtime/chatRealtimeGateway.js` |
| `emitirMovimentacaoInternaAtendimento` | 805 | `chat/realtime/chatRealtimeGateway.js` |
| `incrementarUnreadParaConversa` | 1462 | `chat/unread/conversationUnreadService.js` |
| `emitirParaUsuariosQuePodemVerConversa` | 1463 | `chat/realtime/chatRealtimeGateway.js` |
| `obterUsuarioIdsQuePodemVerConversa` | 1464 | `chat/access/conversationVisibilityService.js` |

### 4.2. Leitura e busca

| Export | Linhas | Observação |
|---|---:|---|
| `listarConversas` | 1475–3106 | 1.632 linhas; filtros SQL e em memória, busca, contagem, paginação, DTO e fallbacks no mesmo handler |
| `detalharChat` | 4311–4675 | acesso, histórico, ocultação, leitura, DTO, movimentação interna e sincronização em background |
| `carregarMensagensAntigasContato` | 4676–4723 | wrapper de caso de uso existente |
| `buscarMensagensConversa` | 4724–4844 | política de leitura, paginação, fallback de schema e enriquecimento |
| `contarConversasPorFiltros` | 9643–9656 | wrapper fino de serviço existente |

`listarConversas` precisa ser decomposto internamente em cinco etapas, preservando sua ordem:

1. normalizar filtros e contexto do usuário;
2. resolver escopo de visibilidade e IDs auxiliares;
3. construir e executar query paginada;
4. enriquecer e transformar linhas em DTOs;
5. aplicar filtros defensivos, ordenação final, preferências e paginação de resposta.

Não se deve mover filtros SQL e filtros defensivos em memória de uma só vez. Eles formam pares de compatibilidade; retirar apenas um lado pode mudar resultados.

### 4.3. Instâncias, sincronização e diagnóstico

| Export | Linhas | Destino sugerido |
|---|---:|---|
| `listWhatsappInstancesAtendimento` | 3255–3281 | `chat/integration/whatsappInstanceController.js` |
| `whatsappStatus` / `zapiStatus` | 3282–3323 | mesmo módulo, preservando alias legado |
| `sincronizarContatosZapi` | 3324–3393 | `chat/integration/contactSyncController.js` |
| `debugSyncContatos` | 3394–3474 | `chat/integration/contactSyncDiagnosticsController.js` |
| `sincronizarFotosPerfilZapi` | 3475–3516 | `chat/integration/contactSyncController.js` |

Os nomes Z-API são contratos legados. A primeira modularização deve apenas realocá-los e reexportá-los; renomear rota/export é uma iniciativa separada.

### 4.4. Contatos, grupos e preferências

| Export | Linhas | Destino sugerido |
|---|---:|---|
| `criarGrupo`, `criarComunidade` | 3517–3581 | `chat/contact/groupController.js` |
| `vincularClienteConversa` | 3582–3661 | `chat/contact/conversationContactController.js` |
| `atualizarNomeContato`, `atualizarObservacao` | 3662–3841 | mesmo módulo |
| `patchConversaPrefs` | 3842–3937 | `chat/preferences/conversationPreferencesController.js` |
| `abrirConversaCliente`, `criarContato` | 4107–4310 | `chat/contact/conversationContactController.js` |
| `adicionarTagConversa`, `removerTagConversa` | 7689–7777 | `chat/preferences/conversationTagsController.js` |

### 4.5. Ciclo de atendimento e colaboração

| Export | Linhas | Destino sugerido |
|---|---:|---|
| `assumirChat`, `encerrarChat`, `reabrirChat` | 4845–5112 | `chat/attendance/attendanceLifecycleController.js` |
| `marcarLidaModoSimplesChat` | 5113–5203 | `chat/attendance/simpleModeController.js` |
| `marcarAguardandoClienteManualChat` | 5204–5235 | `chat/attendance/attendanceStatusController.js` |
| `marcarAguardandoPagamentoFinanceiroChat` | 5236–5277 | `chat/attendance/paymentStatusController.js` |
| `retomarEmAtendimentoManualChat` | 5278–5329 | `chat/attendance/attendanceStatusController.js` |
| `transferirChat`, `transferirSetor` | 5330–5511, 5905–6012 | `chat/attendance/attendanceTransferController.js` |
| `listarAtendentesDisponiveisConversa` | 5512–5551 | `chat/attendance/conversationParticipantsController.js` |
| `criarNotaInterna` | 5552–5621 | `chat/attendance/internalNoteController.js` |
| `removerAtendenteConversa`, `listarAtendentesConversa`, `adicionarAtendenteConversa` | 5622–5904 | `chat/attendance/conversationParticipantsController.js` |
| `listarAtendimentos` | 7500–7578 | `chat/attendance/attendanceHistoryController.js` |
| `puxarChatFila` | 7579–7688 | `chat/attendance/attendanceQueueController.js` |

O padrão desejado é: controller valida transporte, caso de uso executa regra e persistência, realtime publica o resultado. Hoje vários endpoints repetem essa sequência manualmente.

### 4.6. Pix e saída de mensagens

| Export | Linhas | Destino sugerido |
|---|---:|---|
| `getPixConfig`, `putPixConfig`, `enviarMensagemPix` | 6066–6162 | `chat/outbound/pixController.js` |
| `enviarMensagemChat` | 6163–6686 | `chat/outbound/textMessageController.js` + pipeline compartilhado |
| `enviarReacaoMensagem`, `removerReacaoMensagem` | 6687–6820 | `chat/outbound/reactionController.js` |
| `enviarContatoWhatsapp` | 6821–7005 | `chat/outbound/contactMessageController.js` |
| `enviarLocalizacao` | 7006–7200 | `chat/outbound/locationMessageController.js` |
| `enviarLigacaoWhatsapp` | 7201–7296 | `chat/outbound/callMessageController.js` |
| `excluirMensagem` | 7297–7499 | `chat/messages/messageDeletionController.js` |

Todos os envios repetem parte da mesma máquina de estados. O serviço-alvo `outboundMessagePipeline` deve oferecer etapas explícitas e reutilizáveis, sem esconder a ordem:

`validar → deduplicar → autorizar → resolver conversa/instância/telefone → persistir pending → atualizar conversa/cliente → emitir mensagem otimista → chamar provider → persistir resultado → emitir status → agendar reconciliação → responder`.

A emissão antes do provider é intencional no comportamento atual e não deve ser “corrigida” durante a extração.

### 4.7. Mídia, encaminhamento e reenvio

| Bloco | Linhas | Destino sugerido |
|---|---:|---|
| Detecção de tipo/extensão | 7778–7877 | `chat/media/mediaType.js` |
| Áudio/FFmpeg | 7878–8043 | `chat/media/audioNormalizer.js` |
| Vídeo/FFmpeg | 8044–8226 | `chat/media/videoNormalizer.js` |
| Imagem/FFmpeg | 8227–8310 | `chat/media/imageNormalizer.js` |
| Processamento unitário | 8332–8816 | `chat/media/mediaOutboundService.js` |
| `enviarArquivo` | 8817–8974 | `chat/media/mediaMessageController.js` |
| Helpers de encaminhamento | 8975–9185 | `chat/outbound/forwardMediaResolver.js` |
| `encaminharUmaMensagemParaConversa` | 9186–9499 | `chat/outbound/forwardMessageService.js` |
| `encaminharMensagem` | 9500–9642 | `chat/outbound/forwardMessageController.js` |
| Helpers de reenvio | 9691–9890 | `chat/outbound/retryMessageService.js` |
| `reenviarTextoMensagem`, `reenviarMidiaMensagem` | 9891–10031 | `chat/outbound/retryMessageController.js` |

O subsistema de mídia deve ficar isolado do HTTP e receber dependências explícitas: filesystem, diretório temporário, FFmpeg, uploader do provider, R2, relógio e logger. Isso permite testar timeout, limpeza e conversão sem construir `req`/`res`.

### 4.8. Manutenção

| Export | Linhas | Destino sugerido |
|---|---:|---|
| `paginaMergeDuplicatas`, `mergeConversasDuplicadas` | 3107–3254 | `chat/maintenance/duplicateMergeController.js` |
| `limparMensagensConversa`, `apagarConversa` | 3938–4106 | `chat/maintenance/conversationCleanupController.js` |
| `finalizacaoAusenciaLoteAuth` | 9657–9690 | `chat/maintenance/absenceFinalizationController.js` |

O HTML de merge não deve permanecer embutido no controller. Pode ser um asset/template, mas essa mudança deve preservar conteúdo, headers e autenticação atuais.

## 5. Contratos que a modularização deve congelar

### 5.1. Contratos HTTP

- nomes dos exports e aliases;
- status HTTP, mensagens de erro e formato dos JSONs;
- nomes alternativos de parâmetros (`limit`, `per_page`, `page_size`, cursores e aliases);
- headers `X-Chat-List-*` e `Access-Control-Expose-Headers`;
- respostas em array versus objeto paginado;
- status `ociosa` apresentado sem alterar o status real do banco;
- `mensagens_bloqueadas`, `exibir_badge_aberta`, `busca_rank`, `sem_conversa` e demais campos calculados;
- ausência de mensagem completa na resposta de `enviarMensagemChat`, evitando duplicação com socket;
- alias `zapiStatus = whatsappStatus`.

### 5.2. Contratos de autorização

- todas as consultas e mutações continuam limitadas por `company_id`;
- regras especiais para admin, supervisor, atendente, responsável, participante e usuário que transferiu;
- grupos seguem a política de departamentos própria;
- conversas encerradas têm exceções de visualização e exigem reabertura para envio;
- modo simples altera as regras de assumir, leitura e estado de espera;
- financeiro restringe filtros e transições de pagamento.

Alguns handlers não chamam a política central diretamente — por exemplo, tags e histórico de atendimentos usam apenas filtros locais, enquanto o comentário de merge diz “admin only” sem validar o perfil no próprio handler. Como as rotas não foram auditadas, isso deve virar um teste de contrato antes da extração, não uma alteração silenciosa.

### 5.3. Contratos de realtime

- eventos e payloads atuais;
- rooms de conversa, usuário, empresa e departamento;
- sequência entre evento de domínio, `conversa_atualizada`, `atualizar_conversa`, lock e status de mensagem;
- invalidação do cache quando mudam `departamento_id`, `atendente_id`, `tipo` ou vínculo de grupo;
- abertura do detalhe não pode provocar o refetch da lista;
- `skipAtualizarConversa` evita flicker/duplicação e exige sincronização explícita em alguns fluxos;
- web push e FCM agendados nos mesmos momentos.

### 5.4. Contratos de persistência e integração

- `client_temp_id` combina deduplicação local e persistente;
- IDs de fila numéricos não podem contaminar `whatsapp_id`;
- aceite sem ID rastreável permanece `pending/sending` e agenda reconciliação;
- fallbacks de colunas/tabelas ausentes continuam controlados durante o rollout;
- mensagens são persistidas antes do envio ao provider;
- LID nunca é usado como telefone final quando existe resolução segura;
- mídia temporária deve ser removida em sucesso, erro e timeout;
- reenvio não é permitido quando há evidência de aceite prévio do provider.

## 6. Riscos e dívida técnica encontrados

### P0 — tratar antes ou durante as primeiras extrações

1. **Máquinas de estado de saída duplicadas.** Texto, contato, localização, ligação, mídia, encaminhamento e reenvio calculam status do provider de forma semelhante, mas em blocos diferentes. Uma correção aplicada a um caminho pode não alcançar os outros.
2. **Mutações compostas sem transação única.** Merge, apagar conversa, encerrar, reabrir, transferir e envio executam várias gravações. Falha intermediária pode deixar estado parcialmente aplicado. A extração deve primeiro caracterizar esse comportamento; transacionalidade é uma melhoria posterior e separada.
3. **Política de acesso distribuída.** Há política central e verificações locais parcialmente repetidas. Mover handlers sem uma matriz de autorização pode abrir ou bloquear acesso indevidamente.
4. **Ordem de efeitos colaterais é parte do produto.** Persistência, socket, provider e reconciliação não são intercambiáveis. Refactors “limpos” que apenas reordenam `await` podem gerar duplicação ou mensagens fantasmas.

### P1 — alto retorno arquitetural

1. **`listarConversas` é um subsistema dentro de um handler.** A mesma função normaliza, autoriza, consulta, aplica compatibilidade, formata e pagina.
2. **Identidade LID/telefone repetida.** A resolução aparece em múltiplos envios, encaminhamento e reenvio; deve haver um único serviço de endereço de destino.
3. **Realtime repetido e parcialmente direto.** Alguns fluxos usam gateways auxiliares; outros emitem diretamente em rooms. Isso dificulta garantir visibilidade e payload uniforme.
4. **Fallbacks de rollout dispersos.** Detecção por texto como `does not exist`/`schema cache` e flags globais podem mascarar falhas não relacionadas e desabilitar recursos até reiniciar o processo.
5. **Imports dinâmicos e dependências ocultas.** Serviços são requeridos dentro de handlers e callbacks, tornando difícil construir testes e detectar ciclos.
6. **Erros intencionalmente silenciados.** `catch` vazios e updates cujo resultado não é inspecionado reduzem observabilidade. Durante a extração, preservar o comportamento, mas registrar cada silêncio para decisão posterior.
7. **Estado local ao processo.** Cache, deduplicação e lock de reenvio não têm semântica distribuída explícita.

### P2 — limpeza após estabilização

1. nomes legados Z-API em um fluxo UltraMsg;
2. HTML e CSS embutidos;
3. estilos de código e respostas de erro inconsistentes;
4. constantes de domínio, limites e textos espalhados;
5. export `_test` acoplando testes aos detalhes internos do arquivo original.

## 7. Arquitetura-alvo

Estrutura lógica sugerida; os nomes podem ser adaptados ao padrão do repositório quando a implementação começar:

```text
controllers/
  chatController.js                    # fachada compatível; somente reexports
  chat/
    readController.js
    contactController.js
    attendanceController.js
    participantsController.js
    preferencesController.js
    outboundController.js
    mediaController.js
    maintenanceController.js

services/chat/
  access/
    conversationPolicy.js
    conversationVisibilityService.js
  read/
    conversationListService.js
    conversationDetailService.js
    conversationSearchService.js
    pagination.js
  attendance/
    attendanceLifecycleService.js
    attendanceTransferService.js
    participantsService.js
  outbound/
    outboundMessagePipeline.js
    idempotencyService.js
    providerResultMapper.js
    forwardMessageService.js
    retryMessageService.js
  media/
    mediaType.js
    audioNormalizer.js
    videoNormalizer.js
    imageNormalizer.js
    mediaOutboundService.js
  realtime/
    chatRealtimeGateway.js
  identity/
    conversationAddressService.js
  presentation/
    chatDto.js

repositories/chat/
  conversationRepository.js
  messageRepository.js
  attendanceRepository.js
  contactRepository.js
  preferenceRepository.js
```

Direção de dependência:

```text
controller/fachada
        ↓
caso de uso
   ↙    ↓    ↘
policy  repository  gateway/provider
        ↓
Supabase/adaptadores
```

Regras:

- controller não monta query Supabase;
- repository não conhece `req`, `res` ou Socket.IO;
- policy não emite evento;
- gateway realtime não decide regra de negócio;
- DTO não acessa banco;
- pipeline de saída recebe provider e repositórios por dependência;
- módulos de domínio não importam a fachada/controller.

## 8. Plano incremental de execução

### Fase 0 — congelar o comportamento

1. Inventariar cada export, rota correspondente, método HTTP, parâmetros, perfis e resposta.
2. Registrar todos os nomes de evento e o momento em que são emitidos.
3. Criar testes de caracterização para os fluxos P0.
4. Capturar snapshots de DTO da lista, detalhe e todos os tipos de mensagem.
5. Definir fixtures para banco atualizado e banco em rollout com colunas opcionais ausentes.

Saída: baseline confiável; nenhuma extração ainda.

### Fase 1 — extrair funções puras

Extrair normalizadores, parsers de paginação, cursores, status de lista, tags, tipos de mídia, cálculo de transcode, elegibilidade de reenvio e mapeamento de resultado do provider.

Critério: testes unitários sem Supabase, provider, filesystem, relógio real ou Socket.IO.

### Fase 2 — criar adaptadores compartilhados

1. `conversationAddressService` para instância, LID e telefone.
2. `providerResultMapper` para `sent/pending/erro`, `whatsapp_id` e `provider_queue_id`.
3. `idempotencyService` para `client_temp_id` e ciclo do timer.
4. repositories mínimos para conversa, mensagem, atendimento e cliente.
5. gateway realtime único, preservando métodos distintos para eventos visíveis, privados e amplos.

Critério: nenhum endpoint migra antes de os adaptadores reproduzirem o comportamento atual.

### Fase 3 — centralizar acesso e visibilidade

Mover `assertPermissaoConversa`, `assertPodeEnviarMensagem`, participantes e cache de visibilidade. Construir uma matriz de testes por perfil × setor × status × responsável × grupo × participante.

Critério: nenhum handler mantém uma versão paralela da mesma regra sem justificativa documentada.

### Fase 4 — modularizar leituras

Ordem recomendada:

1. `contarConversasPorFiltros` e `carregarMensagensAntigasContato`;
2. busca de mensagens;
3. detalhe;
4. `listarConversas` por etapas internas, sem reescrita total.

Para `listarConversas`, primeiro extraia funções mantendo as queries idênticas; depois mova queries para repository. Cada etapa deve comparar conjuntos, ordenação, headers e cursores com o baseline.

### Fase 5 — modularizar ciclo de atendimento

Extrair assumir, fila, estados manuais, encerrar, reabrir, transferências e participantes. Usar um resultado de caso de uso explícito, por exemplo `{ conversa, atendimento, events }`, mas continuar emitindo eventos no mesmo ponto temporal.

Critério: testes de corrida para assumir/puxar/transferir e testes de falha intermediária.

### Fase 6 — modularizar saída não-mídia

1. Extrair o pipeline comum.
2. Migrar reação e ligação como casos menores.
3. Migrar contato e localização.
4. Migrar texto/link e Pix.
5. Comparar persistência e sequência de sockets antes/depois.

Critério: todos os caminhos usam o mesmo mapeamento de resultado do provider e a mesma resolução de destino.

### Fase 7 — modularizar mídia, encaminhamento e reenvio

1. Isolar FFmpeg e filesystem.
2. Extrair normalizadores por tipo.
3. Extrair processamento unitário e manter lote no controller fino.
4. Extrair resolução local/R2/provider para encaminhamento.
5. Unificar envio de mídia nova, encaminhada e reenviada sobre adaptadores comuns, sem unificar regras que sejam diferentes.

Critério: testes de limpeza de temporário, timeout, arquivo bloqueado, lote parcial, upload alternativo, R2 e provider sem ID rastreável.

### Fase 8 — manutenção, sync e compatibilidade

Mover merge, exclusão, sync e diagnóstico. Só depois decidir:

- transações/RPCs atômicas para mutações compostas;
- remoção dos aliases Z-API;
- fim dos fallbacks de migrations antigas;
- migração de locks/caches para infraestrutura distribuída;
- remoção do HTML embutido.

Essas decisões são melhorias funcionais e não devem ser misturadas à simples modularização.

### Fase 9 — reduzir a fachada

`controllers/chatController.js` deve terminar como uma camada explícita de compatibilidade, idealmente com menos de 200 linhas e apenas imports/reexports. O export `_test` deve ser substituído por imports diretos dos módulos testáveis, mantendo-o temporariamente durante a migração se os testes atuais dependerem dele.

## 9. Estratégia de testes

### 9.1. Testes de caracterização obrigatórios

- lista: cada filtro isolado e combinações relevantes;
- lista: busca por nome, telefone, vínculo, mensagem opcional e cliente sem conversa;
- lista: admin/supervisor/atendente, grupos, setores, transferidos e participantes;
- lista: ordenação por relevância, pin e recência; cursores empatados;
- detalhe: ocultas, movimentações internas, bloqueio por outro atendente e modo simples;
- ciclo: concorrência ao assumir, reabrir, transferir e puxar fila;
- saída: sucesso com ID real, sucesso com ID de fila, falha e exceção;
- idempotência: memória, banco, unique violation e coluna ausente;
- mídia: cada tipo, conversão, timeout, tamanho, lote parcial e limpeza;
- encaminhamento/reenvio: texto, mídia, contato, localização e mensagem inelegível;
- realtime: destinatários, payloads, ordem e ausência de eventos indevidos;
- manutenção: falha em cada passo de merge e exclusão.

### 9.2. Técnicas

- testes unitários para funções puras;
- testes de contrato com `req`/`res`, Supabase, provider e `io` simulados;
- snapshots apenas para DTOs e payloads estáveis;
- testes de integração para queries e concorrência;
- fault injection após cada escrita relevante;
- relógio e timers falsos para cache, TTL, reconciliação e FFmpeg;
- comparação lado a lado do handler antigo e do novo durante cada extração.

## 10. Critérios de aceite da modularização

A modularização estará concluída quando:

- todos os exports públicos e aliases permanecerem disponíveis;
- contratos HTTP e realtime estiverem cobertos e inalterados;
- nenhum controller acessar Supabase, FFmpeg, filesystem, R2 ou provider diretamente;
- autorização e resolução de destino tiverem uma única implementação canônica;
- estados de envio forem mapeados em um único módulo;
- `listarConversas` estiver dividido em etapas testáveis;
- caches, timers e locks tiverem ciclo de vida explícito;
- não houver dependências circulares;
- a fachada tiver somente composição/reexports;
- fallbacks temporários tiverem owner, motivo, telemetria e condição de remoção documentados;
- todas as decisões que alteram comportamento estiverem em mudanças separadas da extração estrutural.

## 11. Ordem prática recomendada

1. Funções puras e DTOs.
2. Mapeamento de resultado do provider e resolução LID/telefone.
3. Realtime e visibilidade.
4. Endpoints wrappers já finos.
5. Leitura de mensagens e detalhe.
6. Ciclo de atendimento.
7. Saída não-mídia.
8. Mídia, encaminhamento e reenvio.
9. `listarConversas`.
10. Manutenção e remoção gradual da fachada.

`listarConversas` não deve ser o primeiro módulo grande extraído: ele depende de quase todos os conceitos de leitura e visibilidade. Preparar as fundações primeiro reduz o risco e evita apenas deslocar uma função gigante para outro arquivo.

## 12. Decisões que precisam ser tomadas na futura implementação

1. Manter repositories finos sobre Supabase ou adotar casos de uso que recebem query builders?
2. Preservar fallbacks de schema por quanto tempo e com qual telemetria?
3. Transformar mutações compostas em RPCs/transações na mesma iniciativa ou em etapa posterior?
4. Qual mecanismo distribuído substituirá locks e deduplicação locais, se houver múltiplas instâncias?
5. Eventos realtime serão apenas efeitos do controller ou uma saída declarativa dos casos de uso?
6. O alias Z-API continuará público até qual versão?
7. Qual limite de tamanho/complexidade será adotado para impedir a formação de novos arquivos monolíticos?

Recomendação: responder essas perguntas em ADRs curtos antes das fases correspondentes. A modularização inicial deve privilegiar compatibilidade observável, extrações pequenas e reversíveis e uma única mudança arquitetural por pull request.
