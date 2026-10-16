# 32 — Encerramento de conversa: por que às vezes não encerrava

> Auditoria 16/10/2026 · gatilho: print do Miguel com a conversa "Antonio Alves Ferreira" parada em
> **Em atendimento** desde 09/10, tendo como última mensagem "Olá! Seu atendimento foi encerrado
> automaticamente…" (com ✓✓, ou seja, **entregue**).
> Correções no working tree — **não deployadas**.

## 1. Os quatro caminhos que encerram uma conversa

| # | Caminho | Arquivo | Ordem |
|---|---|---|---|
| 1 | Botão **Encerrar** | `controllers/chat/attendanceController.js` → `encerrarChat` | fecha → emite realtime → envia mensagem de finalização do chatbot |
| 2 | **Ausência do cliente** (scheduler 5 min / `POST /jobs/finalizacao-ausencia-cliente`) | `services/absenceFinalizationService.js` → `finalizeConversationsByAbsence` | fecha (lock) → envia mensagem → emite realtime |
| 3 | **Ausência em lote** (`POST /jobs/finalizacao-ausencia-lote`) | mesmo service → `finalizeAbsenceForConversaIds` | idem |
| 4 | **Timeout do chatbot** (`POST /jobs/timeout-inatividade-chatbot`) | `controllers/jobsController.js` | **antes:** envia → fecha · **agora:** fecha → envia |

Reabrir uma conversa encerrada só acontece por: cliente mandar mensagem (`reopenPolicy`), botão **Reabrir**,
assumir com `reabrirAoEncaminhar`, e — por desenho do módulo Disparo — um novo envio de campanha
(`marcarAguardandoRespostaCampanha` leva `fechada` → `aberta`, ver §5).

## 2. A causa do print: a reversão por falha de envio prendia a conversa para sempre

`finalizeConversationsByAbsence` fechava a conversa, chamava `sendAbsenceClosingMessage` e, se o
resultado não fosse `ok`, **revertia** para `em_atendimento` devolvendo o atendente anterior.

Dois problemas combinados:

1. **Qualquer** falha revertia — inclusive a **transitória** (timeout, rede, 429, 5xx). Na Whapi,
   `transportFailure()` devolve `{ ok:false, transportError:true }` depois de a requisição possivelmente
   já ter sido processada: o cliente **recebe** a mensagem e o ACK chega depois (daí o ✓✓ do print).
2. `sendAbsenceClosingMessage` gravava a linha em `mensagens` **mesmo com `ok=false`**. Com isso a
   mensagem de ausência virava a **última mensagem da conversa** — e ela não conta como fala de
   atendente humano (`isHumanAttendantLastOutbound` devolve `false` para o texto configurado e para
   `ABSENCE_FALLBACK_MESSAGE`). Todo ciclo seguinte caía em `clearWaitingForClient()` + `continue`.

Resultado: conversa revertida para "Em atendimento", com o atendente de volta, a mensagem de despedida
no fim do histórico e **nenhum caminho automático capaz de fechá-la de novo**. Só o clique manual em
Encerrar saía desse estado — exatamente o que o Miguel relatou como "não finaliza".

Rastro no banco: `historico_atendimentos.acao = 'encerramento_ausencia_falha_envio'`.

### Correção

- `sendAbsenceClosingMessage` passou a usar `enviarSemEstourar` + `mapProviderSendResultComTransitoria`
  (mesma política do chat outbound, doc 13): falha transitória vira `pending`/`sending` e entra na
  varredura `pendingOutboundReconciliationService` (que consulta o provedor antes de reenviar — não duplica).
- **Falha transitória não reverte mais.** A conversa fica encerrada e grava
  `historico_atendimentos.acao = 'encerramento_ausencia_envio_pendente'`.
- **Recusa definitiva** (4xx, token inválido, destino inválido) continua revertendo, mas **sem gravar a
  bolha** — a última mensagem volta a ser a do atendente e o ciclo seguinte tenta de novo normalmente.
- Mesma mudança no caminho em lote (`finalizeAbsenceForConversaIds`).

## 3. Auto-reparo do passivo

Conversas que já estão presas não voltariam sozinhas. O scan ganhou um ramo dedicado:

`ehEncerramentoAusenciaInterrompido(conv, lastMsg, absence)` → `true` quando a conversa está
`em_atendimento`, `ausencia_mensagem_enviada_em IS NULL` e a **última** mensagem é outbound, **sem autor**
(`autor_usuario_id` nulo) e com texto exatamente igual à mensagem de ausência configurada (ou ao
`ABSENCE_FALLBACK_MESSAGE`). Só a reversão produz esse estado.

Nesse caso `concluirEncerramentoAusenciaInterrompido` **fecha a conversa sem reenviar nada** (a mensagem
já está lá e pode ter sido entregue), gravando `ausencia_mensagem_enviada_em = criado_em da mensagem` e
emitindo o realtime de encerramento sem nova bolha. Antes de fechar confere que não há inbound depois da
mensagem (`hasInboundAfterTimestamp`, que devolve `true` em erro — falha fecha nada).

Limite: só roda para empresas com a finalização por ausência **ligada**. Para as outras, usar o reparo
manual em `supabase/scripts_manuais/diagnostico/CONVERSAS_PRESAS_ENCERRAMENTO.sql` (consulta 4).

## 3.1. Segunda causa: resíduo de encerramento excluía a conversa do scan para sempre

O scan filtrava `.or('finalizacao_motivo.is.null,finalizacao_motivo.neq.ausencia_cliente')`. Uma
conversa **em atendimento** com `finalizacao_motivo = 'ausencia_cliente'` é resíduo: alguém a tirou de
"fechada" sem limpar os campos de encerramento automático. Acontece em dois caminhos reais:

- `marcarAguardandoRespostaCampanha` (`services/disparoConversaOrigemService.js`): novo disparo para um
  contato com conversa fechada faz `fechada → aberta` sem limpar `finalizacao_motivo` /
  `finalizada_automaticamente_em`;
- bloco "separar mensagens disparadas" (`webhookZapiController` ~2300): `fechada → mensagem_disparada`,
  idem.

Depois disso basta um atendente assumir (de `aberta`, `executarAssumirConversa` só limpa esses campos
quando `reabrindo`, isto é, quando o status de origem era fechado) para a conversa virar
`em_atendimento` com o resíduo — e aí o filtro a excluía **de todos os ciclos futuros**. Mesmo sem o
filtro, o lock `.is('finalizada_automaticamente_em', null)` a barraria.

**Correção:** o filtro saiu do scan. `markWaitingForClient`, que roda logo no início do processamento de
cada candidata, já zera `finalizacao_motivo` / `finalizada_automaticamente` / `finalizada_automaticamente_em`
— então o resíduo é limpo antes do lock e o encerramento volta a funcionar. Fechar continua exigindo
prazo vencido e nenhuma mensagem do cliente; nada foi afrouxado nesse sentido.

## 4. Outros furos corrigidos no mesmo fluxo

| Onde | Problema | Correção |
|---|---|---|
| `encerrarChat` | `registrarAtendimento` falhando devolvia **500 depois da conversa já estar fechada**: o frontend revertia o card (`encerrar_conversa_revert`) e ninguém recebia o realtime → "finalizei e não finalizou" com a conversa fechada no banco. | Erro de histórico agora só loga; o encerramento segue e responde `ok`. O protocolo é o único recurso perdido (a mensagem de finalização que depende dele já era condicional a `atendimentoEncerrou?.id`). |
| `encerrarChat` | UPDATE único com colunas opcionais (`pagamento_*`, `reaberta_falta_interacao_em`). Um erro `column/schema cache` derrubava o encerramento inteiro — `reabrirChat` já tinha fallback, `encerrarChat` não. | Mesmo padrão do `reabrirChat`: patch base + patch opcional, com retry só no base. |
| `reabrirChat` / `transferirChat` | Mesmo 500 pós-efeito do `registrarAtendimento` (reabria/transferia no banco e a tela revertia; a 2ª tentativa batia em 409). | Só loga. |
| `timeoutInatividadeChatbot` | Enviava a mensagem **antes** do UPDATE com lock. Se o lock não pegasse, a conversa ficava aberta com a mensagem enviada — e o ciclo seguinte **reenviava a mesma mensagem** indefinidamente. | Fecha primeiro (lock `.eq(status revalidado)`), só então envia; envio com `enviarSemEstourar` + classificação de transitória. |

## 5. Comportamentos que **não** são bug (não "corrigir" sem decisão de produto)

- `marcarAguardandoRespostaCampanha` (`services/disparoConversaOrigemService.js`) leva conversa
  `fechada` → `aberta` quando um novo disparo sai para aquele contato. É desenho do módulo Disparo
  (`atendimentoHumanoAtivo` ignora conversa fechada de propósito).
- Bloco "separar mensagens disparadas" (`webhookZapiController` ~2300) leva `fechada` →
  `mensagem_disparada` para outbound do celular sem nenhum inbound no histórico.
- Conversa em `aguardando_cliente` (botão **Aguardar cliente**) **nunca** é finalizada por ausência:
  o scan filtra `status_atendimento = 'em_atendimento'`. O alarme dela é o
  `aguardandoClienteMonitorService` (etiquetas por tempo), que não encerra nada.
- Conversa reaberta pelo alarme "sem resposta" vai para `aberta` com `atendente_id` nulo e sai do
  alcance da finalização por ausência (que exige atendente).

## 6. Como validar

```bash
npx jest tests/encerramentoAusenciaGarantia.test.js tests/encerrarChatGarantia.test.js
```

- `tests/encerramentoAusenciaGarantia.test.js` — transitória não reverte · exceção de transporte não
  derruba · definitiva reverte sem bolha · auto-reparo fecha sem reenviar · inbound posterior impede o
  reparo · texto digitado por humano não é tratado como encerramento.
- `tests/encerrarChatGarantia.test.js` — histórico falho não vira 500 · fallback de coluna opcional ·
  erro real continua 500 · grupo recusado.

Banco: `supabase/scripts_manuais/diagnostico/CONVERSAS_PRESAS_ENCERRAMENTO.sql` (consultas 1–3 somente
leitura; consulta 2 lista o passivo e deve esvaziar sozinha ~10 min depois do deploy).

Sem migration. Realtime inalterado (mesmos eventos de `emitirRealtimeEncerramentoAutomatico`).
