# Socket.IO e tempo real

> Análise estática: 2026-08-23 · `master` · commit-base `66e0771d9f61f840524cd4b0645e742df374a77a` · fontes: `index.js`, `socket/*.js`, `helpers/socketEvents.js`, controllers/services com `.emit` e testes de socket.

## Inicialização e autenticação

`index.js` cria `http.Server` e `Socket.IO` no mesmo processo do Express. O handshake exige JWT; a autenticação valida assinatura/expiração e exige `company_id`. Ao conectar, o socket entra em `empresa_<company_id>`, `usuario_<user_id>`, salas de departamentos autorizados e `internal_user_<user_id>`. Acesso a uma conversa é revalidado ao entrar em `conversa_<id>`.

O servidor recebe o evento Socket.IO `connection`; cada socket recebe `disconnect`. Na comparação mecânica de `.on`, `data`, `end`, `error` e `close` pertencem a streams/HTTP, enquanto `SIGINT`, `SIGTERM`, `uncaughtException` e `unhandledRejection` pertencem ao processo Node — não são contrato Socket.IO.

Salas confirmadas:

| Sala | Uso |
|---|---|
| `empresa_<id>` | broadcast tenant-wide de operação/configuração/campanha |
| `usuario_<id>` | eventos privados/push lógico |
| `departamento_<id>` | visibilidade de fila/setor |
| `conversa_<id>` | mensagens/status/typing da conversa |
| `internal_user_<id>` | chat interno |

## Eventos recebidos do cliente

| Evento | Payload relevante | Efeito/validação |
|---|---|---|
| `join_conversa` / `leave_conversa` | id da conversa | valida tenant/visibilidade, entra/sai da sala. |
| `typing_start` / `typing_stop` | conversa e metadados mínimos | retransmite presença de digitação apenas no escopo permitido. |
| `marcar_conversa_lida` | conversa | atualiza leitura e pode emitir `mensagens_lidas`. |
| `disconnect` | motivo implícito | limpa presença local; não altera credencial. |

Handlers adicionais do chat interno mantêm presença/last-seen em `socket/internalChatSocket.js`. Payloads são objetos de entidade/resumo, não um schema versionado; o emissor citado no código é a fonte normativa.

## Eventos emitidos

| Domínio | Eventos confirmados |
|---|---|
| Conversas/mensagens | `nova_mensagem`, `status_mensagem`, `nova_conversa`, `conversa_atualizada`, `atualizar_conversa`, `conversa_apagada`, `contato_atualizado`, `mensagens_lidas`, `tag_adicionada`, `tag_removida`, `conversa_transferida`, `mensagem_interna_atendimento`, `conversa_encerrada`, `conversa_reaberta`, `conversa_atribuida`, `conversa_lock`, `mensagem_editada`, `typing_start` e `typing_stop`. |
| Alertas/sync/legado | `alerta_sem_resposta`, `alerta_sem_resposta_evento`, `zapi_sync_contatos`, `whatsapp_sync_mensagens_antigas`, `crm:lead_updated` e `crm:kanban_refresh`. |
| Help desk | `helpdesk:notification`, `helpdesk:notifications_changed`, `helpdesk:queue_changed`, `helpdesk:ticket_changed`. |
| Chat interno | `internal_chat:conversation_created`, `internal_chat:message_created`, `internal_chat:conversation_read`. |
| Disparo | `disparo_campanha_iniciada`, `disparo_campanha_pausada`, `disparo_campanha_retomada`, `disparo_campanha_cancelada`, `disparo_campanha_concluida`, `disparo_item_atualizado`, `disparo_instancia_desconectada`, `disparo_limite_atingido`, `disparo_optout_registrado`, `disparo_optout_reativado`, `disparo_resposta_vinculada`; aliases `disparo_optout`, `disparo_resposta`, `disparo_reconciliado`. |

Payloads normalmente carregam ids, status e a entidade necessária para atualização incremental. Dados sensíveis do provider não devem ser incluídos. Alguns emissores publicam em empresa + conversa/usuário; antes de ampliar payload, revisar visibilidade de atendente/departamento, pois pertencer ao tenant não implica acesso a toda conversa.

## Reconexão, listeners e escala

- Não existe dependência/configuração de Redis nem `@socket.io/redis-adapter`: **adapter Redis ausente, confirmado**.
- PM2 está em `fork` com uma instância. Presença, mapas de sockets e proteções contra listener duplicado são locais ao processo.
- Ao reiniciar, clientes reconectam e reentram nas salas pelo handshake; presença/last-seen em memória é perdida e a UI deve refazer consultas HTTP.
- Em múltiplos processos, um emit alcançaria apenas clientes do processo local e a presença divergiría. Schedulers também duplicariam. Escala horizontal requer adapter/pub-sub e coordenação distribuída antes de aumentar `instances`.
- O código instala handlers no bootstrap e módulos de socket; alterações devem garantir uma única instalação por `io` para não duplicar efeitos. Há testes de dedupe de listeners em pontos críticos, mas cobertura não prova topologias multi-processo.

## Checklist para evento novo

Definir origem, sala mínima, tenant obtido do contexto, payload sem segredo, idempotência da UI, comportamento offline/reload, compatibilidade com nomes existentes e teste que conecte dois tenants. Não usar `io.emit` global para dados de negócio.
