# 26 — Triagem Interativa Whapi (módulo novo, aditivo)

> Criado: **2026-09-09**. Complementa o doc 25 (§27 interativo / §29 poll). **Backend + frontend
> escritos; migration NÃO aplicada; nada commitado/deployado.** Testes: `tests/whapiTriage.test.js` (7).

## Objetivo

Recurso EXCLUSIVO de instâncias `whatsapp_instances.provider = 'whapi'`: em vez do menu de texto/números
(Chatbot de Triagem atual), envia menu **nativo do WhatsApp** (enquete / lista / botões) e casa a escolha
por **id estável** (independe do label). **Coexiste** com o chatbot de texto: UltraMSG e Whapi-sem-módulo
seguem byte-a-byte como hoje.

## Princípio de desenho — reusar o motor, trocar a apresentação

Não há segundo motor de triagem. Reusa o miolo testado do `chatbotTriageService`:
`transferToDepartment` (claim atômico + distribuição), `logBotAction`, `wasMenuSentForConversa`,
`wasOptionSelectedForConversa`. Dois seams no pipeline de inbound:

- **Seam A (menu):** na 1ª mensagem do cliente, envia o menu interativo via `getProvider({provider:'whapi'}).sendPoll/sendInteractive`.
- **Seam B (resposta):** `interactiveReplyId` (id UUID estável) → opção → `transferToDepartment`. Fallbacks: título, voto de enquete (label).

O `webhookWhapiController` já normaliza a resposta interativa (`interactiveReplyId`/`interactiveReplyTitle`)
e o voto de enquete (`pollVoteOptions`) — nada mudou lá.

## Arquivos

**Novos (backend):**
- `supabase/migrations/20260910120000_whapi_triage_interativa.sql` — tabelas `whapi_triage_config` + `whapi_triage_options` (**NÃO aplicada**).
- `services/whapiTriage/whapiTriageConfigService.js` — CRUD + cache; resiliente à ausência das tabelas (recurso off).
- `services/whapiTriage/whapiTriageRenderer.js` — monta payload poll/list/button (ids estáveis).
- `services/whapiTriage/whapiTriageService.js` — orquestra Seam A + B; reusa `transferToDepartment`.
- `controllers/whapiTriageController.js` + `routes/whapiTriageRoutes.js` — `GET /instances`, `GET/PUT /config`.

**Novos (frontend):**
- `src/api/whapiTriageService.js`
- `src/whapi-business/WhapiTriagemPage.jsx` + `whapiTriagem.css`

**Editados (aditivo, guardado):**
- `app.js` — monta `/whapi/triagem` e `/api/whapi/triagem`.
- `controllers/webhookZapiController.js` — bloco guardado antes do chatbot de texto: só roda quando
  `provider==='whapi'` E `getActiveWhapiTriageConfig` != null; então `skipChatbot=true` (o módulo Whapi
  é o dono da triagem). Fora disso, nada muda.
- `src/routes/AppRoutes.jsx` — rota `/whatsapp-business/triagem-interativa` (supervisor/admin).
- `src/whapi-business/WhapiBusinessLayout.jsx` — aba "Triagem Interativa".

## Feature gating

1. Página só aparece no módulo Whapi (`/whatsapp-business`), aba visível a supervisor/admin.
2. `GET /api/whapi/triagem/instances` só lista canais `provider='whapi'`; empresa sem Whapi → vazio/501.
3. Runtime: o pipeline só chama o handler quando o inbound é `provider='whapi'` E `enabled=true` para a instância.
4. Config **por instância** (`company_id` + `whatsapp_instance_id`), `enabled` default `false` (opt-in).

## Modelagem

- `whapi_triage_config` (1 por instância): enabled, mode (poll|list|button), body_text, button_label,
  header/footer, confirm_message, fallback_to_text.
- `whapi_triage_options`: **id UUID = provider_option_id estável** (enviado como id do botão/linha),
  label, departamento_id (sem FK — runtime valida), tag_id, ordem, active.
- `company_id` em ambas (SERVICE_ROLE bypassa RLS — filtro explícito no código).

## Ordem de deploy (OBRIGATÓRIA)

1. Aplicar `20260910120000_whapi_triage_interativa.sql` no banco.
2. Deploy do backend (código lê as tabelas; sem elas, o serviço se comporta como "desligado" — não quebra).
3. Deploy do frontend.
4. Habilitar numa empresa Whapi de teste, configurar opções→setor, homologar live (poll é o modo estável).

## Homologação PENDENTE (live)

- Shape exato do `interactiveReplyId` (buttons_reply/list_reply) e do voto de enquete — o resolver tolera variações e faz fallback por label (ver doc 25 §27.3/§28.3).
- Modo `poll` é o recomendado (botões instáveis no WhatsApp, aviso oficial Whapi).

## Não regressão

- `getActiveWhapiTriageConfig` retorna null para UltraMSG / módulo off / migration pendente → o seam é no-op.
- Suítes críticas verdes após o edit: `receberZapiContract`, `receberZapiInbound`, `chatbotTriage*`,
  `chatbotInboundGuard`, `providerRouting`, `webhookZapiPure` (120) + `whapiTriage` (7).

## 2026-11-24 — Mensagem fora do horário com a triagem interativa ligada

**Bug:** com o módulo ligado, o webhook marca `skipChatbot = true` e o chatbot de texto não roda —
e a mensagem fora do horário/almoço (seção 4 do Chatbot de Triagem) morava DENTRO dele. Cliente
escrevia às 22h e recebia o menu interativo, nunca o aviso.

**Regra agora:** um único ponto de envio, `handleForaHorarioInbound` (em `chatbotTriageService.js`),
usado pelo chatbot de texto E por `handleWhapiTriageInbound` (via `aplicarForaHorario`). A config
(horário, UF/fuso, almoço, dias, feriados, mensagem) continua só no `chatbot_triage` — o módulo Whapi
não tem config de horário própria. Decisão pura em `avaliarForaHorario(config, now)`.

- Fora do expediente / almoço: envia o aviso e **não** envia o menu (igual ao chatbot de texto).
- Exceção Whapi: cliente que **tocou numa opção** de um menu recebido ainda no expediente tem a
  escolha respeitada (aviso primeiro, depois transferência + confirmação). Sem isso o toque se perdia
  e o menu, já marcado como enviado, não era reenviado.
- Dedup/cooldown/máx. 24h/lock são os mesmos (`bot_logs.tipo='fora_horario'`, `detalhes.origem`
  diz `whapi_triage` ou `chatbot_triage`). Envio passa pelo `createTriageSendGuard`.

**Bug 2 (vale para os dois caminhos):** `hasHumanIntervenedRecently` sem âncora de menu olhava a última
`out` das 40 mensagens — numa conversa **reaberta** (bot_logs apagados no reset) era a fala do
atendente do atendimento antigo → "humano interveio" → aviso calado para todo cliente que volta.
Agora: conversa reaberta neste inbound (`conversaReabertaAposFinalizacao`, repassado também à triagem
Whapi) pula a checagem; fora isso só conta fala humana das últimas 6 h (`FORA_HORARIO_HUMANO_JANELA_MS`).
A checagem da "opção inválida" não mudou (não passa `sinceMs`).

**Extra:** `insertBotOutboundMensagem` trata 23505 com `whatsapp_id` (eco Whapi chegou antes do insert)
como "já gravado", sem log de erro falso.

Testes: `tests/foraHorarioTriagemInterativa.test.js` (20). Sem migration.
