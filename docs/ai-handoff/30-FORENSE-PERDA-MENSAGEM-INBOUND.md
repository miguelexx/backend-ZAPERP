# 30 — Forense: perda de mensagem inbound (caso "Enzo Lopes", 28/09/2026 11:18)

> 2026-09-29 · investigação SOMENTE LEITURA (nada alterado). Caso: mensagem de contato
> visível no WhatsApp Web da empresa Teacher Rafaela não aparece no ZapERP.
> Veredicto por evidência: rodar §3. Este doc lista TODOS os caminhos de perda encontrados.

## 1. Caminhos onde inbound legítimo se perde COM HTTP 200 (provedor não retenta)

| # | Onde | Condição | Class. |
|---|------|----------|--------|
| 1 | `webhookZapiController.js:2128-2131` + `persistMensagem.js:161` + `:2594` | INSERT falhou (FK/timeout/fallback falho) → `continue` → **200** | PROBLEMA |
| 2 | `webhookZapiController.js:1108-1114`, `:1254-1260` | erro/null ao obter conversa (inclusive erro transitório do Supabase) → `continue` → 200 | PROBLEMA |
| 3 | `resolveWebhookCompany.js:124-143` + `whatsappInstanceService.js:341-348` | **erro de banco** no SELECT da instância vira `ignored_not_mapped` → 200 (webhook_logs guarda `error_message` = prova) | PROBLEMA |
| 4 | `webhookZapiController.js:1327-1344` + `closedConversationEcho.js` + `reopenPolicy.js:102-151` | conversa fechada/finalizada + texto "parece eco nosso": contém "protocolo"+encerrado/finalizado, "seja bem vindo", "escolha o setor" (SEM janela de tempo), ou igual/prefixo de outbound dos últimos 3 min → `continue` ANTES do insert | PROBLEMA |
| 5 | `webhookUltramsgController.js:121-125` → `payload.js:265-302` → `conversationSync.js:1049-1056` | `data.from=@lid` via UltraMSG: normalizador tira o `@lid`, dígitos não passam como BR, `findOrCreateConversation`=null → descartada (log: `last resort non-BR` / `Telefone inválido para BR`) | PROBLEMA |
| 6 | `webhookWhapiController.js:63-79`, `:1050-1053` | Whapi com `sync_historico='off'`: item com timestamp >2 min é descartado **em silêncio** — inclusive a reentrega pós-500 que o próprio código pede | PROBLEMA |
| 7 | `payload.js:350` | payload sem `data.id`/`sid` → `whatsapp_id = instanceId`; a 2ª mensagem sem id na instância "deduplica" contra a 1ª e some | RISCO |
| 8 | `statusZapi.js:225-284` fallbacks 3/3b | ACK grava id `false_…` em linha OUT pendente → inbound posterior deduplica contra linha OUT | RISCO |
| 9 | merge LID→telefone durante insert (`conversationSync.js:163-174`) | FK 23503 no insert + fallback falho → 200; ou duplicata fica `fechada,lida` com as mensagens (escondida) | RISCO |
| 10 | `webhookLimiter` roda ANTES do `webhookLogger` (`app.js:129-135`) | 429/400/413 **não deixam rastro** em webhook_logs | RISCO forense |

"Salva mas invisível" (não é perda no banco): reopenPolicy mantém fechada p/ "ok/sim/não/avaliação" → só em Finalizadas; transferência de setor tira a conversa da vista do atendente original; conversa `lid:`/outra instância aparece como contato separado.

## 2. COMPROVADO CORRETO (não mexer)

Dedup por unique de whatsapp_id (23505→merge, guarda `inboundReentregue` NÃO bloqueia insert); reabertura condicional não bloqueia insert; chatbot/opt-out/regras em try próprio (falha não impede insert); efeitos pós-insert (unread/socket/ultima_atividade) nunca causam rollback; supabase-js retorna `{error}` e `persistMensagem` sempre checa; reconciliação por texto só roda com fromMe=true; frontend após F5 não esconde texto simples (sem cache persistente; dedup só por id/whatsapp_id) — exceções exóticas: texto hash-like vira "(voto na enquete)" (`conversaOutboundMediaMerge.js:338-357`), legenda repetida ≤5s e `tipo='reaction'` não renderizam; `isMensagemLegadaMovimentacaoInterna` esconde 1ª linha com "movimenta"+"interna".

Efeito colateral achado de passagem: `atualizar_conversa` de fundo faz cada navegador dar GET /chats/:id → `marcarComoLidaPorUsuario` **zera o badge sem ninguém abrir a conversa**.

## 3. Prova do caso (Miguel roda; ver queries completas na conversa de 2026-09-29)

1. `webhook_logs` 28/09 14:10–14:30 UTC, SEM filtro de company (fica null no not_mapped): sem linha = provedor não entregou; `ignored_not_mapped`+error_message = #3; 500 = exceção; `processed` 200 sem linha em `mensagens` = #1/#2/#4/#5/#7.
2. `mensagens WHERE texto ILIKE '%enzo%'` na empresa: achou em outro conversa_id = extravio/LID; achou na conversa mas ela ficou `fechada` = reopenPolicy (não é perda).
3. PM2 na janela: `eco da nossa mensagem` (#4), `last resort non-BR` (#5), `Erro ao salvar mensagem` (#1), `Erro ao obter/criar conversa` (#2), `DROPPED`, `skipped_historical` (#6).
4. `historico_atendimentos`/`atendimentos` da conversa: estava finalizada entre 10:23 e 11:18?

## 4. Correções candidatas (NENHUMA aplicada — aguardando decisão)

a) #1/#2: responder **500** quando persist/conversa falhar (idempotência já protege a reentrega; alinha com doc 06:50 e com o Whapi).
b) #3: distinguir erro de banco de "instância inexistente" → 500 no erro.
c) #4: exigir sinal real de eco (whatsapp_id out OU janela de tempo nos padrões de texto) antes de descartar; no mínimo, inserir a mensagem e só pular a reabertura.
d) #6: aplicar a guarda histórica só a payloads sem retry (ou marcar reentrega); logar o descarte.
e) #10: mover webhookLogger para antes do limiter (rastro de 429).
f) Observabilidade: `webhookLogData.status='persist_failed'`+`error_message` nos continues; hoje tudo vira `processed` 200.
