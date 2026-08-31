# 19 — Atendimento sem resposta: mapa para modularização

> Criado: **2026-08-31**. Fonte: código atual.  
> **Executado em 2026-08-31:** o service foi fatiado. Este doc permanece como mapa de invariantes e pastas.  
> Estados: **CONFIRMADO** = observado no código/teste/migration; **INFERÊNCIA** = consequência direta; **PENDENTE** = exige banco/VPS.

Fachada estável: [`services/atendimentoSemRespostaService.js`](../../services/atendimentoSemRespostaService.js) (shim).  
Implementação: [`services/atendimentoSemResposta/`](../../services/atendimentoSemResposta/).  
Horário comercial compartilhado: [`helpers/businessSchedule.js`](../../helpers/businessSchedule.js).  
Scheduler: [`services/atendimentoSemRespostaScheduler.js`](../../services/atendimentoSemRespostaScheduler.js).

---

## 1. O que o módulo faz

Alerta progressivo quando uma conversa **`em_atendimento`** com atendente atribuído está **esperando resposta humana**: a última mensagem é `direcao = 'in'` e o tempo útil (horário comercial) passou dos limiares configurados.

Três estágios, nesta ordem (tempos iguais são válidos):

| Estágio | Campo de estado | Default | Efeito típico |
|---------|-----------------|---------|----------------|
| Primeiro alerta | `primeiro_alerta_em` | 1 min | Socket `alerta_sem_resposta` + evento persistido |
| Alerta crítico | `alerta_critico_em` | 3 min | Idem, nível `critico` |
| Gestor | `gestor_notificado_em` | 5 min | Socket (atendente + gestor), WhatsApp opcional, e-mail **só registrado como indisponível**, reabertura opcional, tag opcional |

Config por empresa: JSON `ia_config.config.alerta_sem_resposta`. Idempotência por conversa: tabela `alerta_atendimento_sem_resposta_estado`. Auditoria: `alerta_atendimento_sem_resposta_eventos`.

---

## 2. Por que modularizar (e o que não é objetivo)

O arquivo mistura **seis assuntos** no mesmo módulo CommonJS:

1. Normalização/validação/CRUD de config
2. Horário comercial (reutilizado pelo SLA)
3. Persistência de estado/eventos + claim concorrente
4. Notificações (Socket, UltraMSG, stub de e-mail)
5. Efeitos colaterais na conversa (reabrir, tag, histórico)
6. Orquestração do job (`processCompany…`, ~312 linhas)

Modularizar serve para: testes isolados, reduzir o acoplamento acidental com o SLA, e permitir PRs pequenos. **Não** é objetivo desta quebra: mudar regra de negócio, implementar SMTP, eliminar N+1, nem “melhorar” o claim.

---

## 3. Mapa de responsabilidades (linhas atuais)

Numeração **CONFIRMADA** em `atendimentoSemRespostaService.js` na data deste doc.

| Bloco | Linhas | ~Qtd | I/O | Candidato a |
|-------|--------|------|-----|-------------|
| Defaults + coerce/normalize/validate config | 13–178 | 166 | puro (+ env só na validação de refs) | `config.js` |
| Refs (usuário/cliente/SMTP) + load/save `ia_config` | 180–313 | 134 | Supabase + env | `config.js` (I/O) |
| Eventos + estado + reset ao assumir | 315–469 | 155 | Supabase | `stateStore.js` |
| Última mensagem, revalidação, `claimEstadoStage` | 471–570 | 100 | Supabase | `stateStore.js` + `cycle.js` |
| Socket + tags + WhatsApp gestor + texto | 572–793 | 222 | Socket, Supabase, provider | `notifications.js` + `tags.js` |
| `reabrirConversa` | 795–859 | 65 | Supabase + helper badge | `reopen.js` |
| Horário comercial (janelas, timezone, minutos úteis) | 861–1099 | 239 | puro; `loadBusinessSchedule` lê `ia_config` | **módulo compartilhado** (ver §7) |
| `processCompanyAtendimentoSemResposta` | 1101–1413 | 313 | orquestra tudo | `processor.js` (último a quebrar) |
| `runAtendimentoSemRespostaForAllCompanies` | 1415–1433 | 19 | lista `empresas` | `processor.js` |
| `module.exports` (fachada pública) | 1435–1463 | — | — | `index.js` + shim no path antigo |

O scheduler (intervalo 1–10 min, default 1; primeiro tick em 35 s; lock `running` em memória) **já está fora** e não precisa entrar na pasta nova.

---

## 4. API pública que a fachada deve preservar

Callers atuais **CONFIRMADOS**. Qualquer split deve manter `require('../services/atendimentoSemRespostaService')` funcionando (re-export).

| Export | Usado por | Manter |
|--------|-----------|--------|
| `processCompanyAtendimentoSemResposta` | `atendimentoSemRespostaController.processar` | sim |
| `runAtendimentoSemRespostaForAllCompanies` | scheduler + `jobsController` (`POST /jobs/atendimento-sem-resposta`) | sim |
| `getAlertaSemRespostaConfigForApi` / `saveAlertaSemRespostaConfig` / `listAlertaSemRespostaEventos` | controller HTTP | sim |
| `resetAlertaSemRespostaAoAssumirReaberta` | `chatController` (reabrir/puxar) e `conversaAssumirInternoService` | sim — **ciclo de âncora** |
| `businessMinutesBetween`, `normalizeBusinessSchedule`, `describeBusinessSchedule`, `mergeScheduleSource` | `slaCalculationService` | sim — extração compartilhada |
| `businessMinutesBetween` | também `tests/slaCalculationService.test.js` | sim |
| `DEFAULT_ALERTA_SEM_RESPOSTA`, `normalizeAlertaSemResposta`, `validateAlertaSemResposta`, `resolveAlertaRuntimeConfig`, `isBusinessTime`, `resolveAlertaSemRespostaCycleAnchor`, `buildAlertaSemRespostaResetPatch`, `formatTempoSemResposta`, `buildGestorWhatsappText` | `tests/atendimentoSemRespostaService.test.js` | sim |
| `getAlertaSemRespostaConfig`, `alertConfigHasOwnSchedule`, `emitAlertaRealtime`, `clearEstado`, `clearReabertaFaltaInteracao`, `getBusinessScheduleInfo`, `resolveGestorWhatsappDestination`, `sendGestorWhatsapp` | só internos ou re-export morto | manter na fachada na 1ª PR (compat); depois pode deixar de exportar se grep zerar |

**CONFIRMADO:** `getBusinessScheduleInfo` é importado em `atendimentoSemRespostaController.js` e **não é usado** (o `horario_comercial` vem do retorno de `processCompany…`). Não “limpar” isso no mesmo PR da quebra estrutural.

**CONFIRMADO:** `clearReabertaFaltaInteracao` é re-exportado pelo service, mas os callers reais (`chatController`, `conversaAssumirInternoService`, `webhookZapiController`) importam o helper. Não misturar os dois módulos na 1ª extração.

---

## 5. Fluxo do job (o que o processor realmente faz)

```
runAtendimentoSemRespostaForAllCompanies
  → empresas.id (sem filtro — job de sistema)
  → processCompanyAtendimentoSemResposta(company_id)
       se alerta inativo → skipped: inativo
       se agora fora do horário comercial → skipped: fora_horario (não zera estado)
       senão: SELECT conversas em_atendimento com atendente_id
       para cada conversa:
         última mensagem (N+1)
         se não for direcao=in → clearEstado
         âncora do ciclo (mensagem do cliente vs reset pós-assunção)
         se nova msg do cliente depois da âncora → zera estágios no estado
         minutos = businessMinutesBetween(âncora, now, schedule, cap=maior limiar)
         empilha ações cujo limiar venceu e cujo campo de estado ainda é null
         dryRun: não persiste, só reporta
         senão, por ação:
           revalidateConversaElegivel (ainda em_atendimento, mesmo atendente, última ainda in)
           se NÃO for gestor: claimEstadoStage ANTES de notificar
           se notificar_interno: socket + recordEvento
           se gestor:
             WhatsApp (se ligado) — se falhar, ABORTA o estágio (sem claim)
             claimEstadoStage DEPOIS do WhatsApp
             e-mail: só grava evento email_indisponivel (SMTP não envia)
             reabrir + tag + sockets conversa_atualizada
           upsertEstado (redundante após claim — preservar)
```

### 5.1 Invariantes de claim (não regressar)

**CONFIRMADO** em `claimEstadoStage` (linhas 521–570):

- Update atômico: `company_id` + `conversa_id` + `ultimo_cliente_msg_em = âncora` + estágio `IS NULL`.
- Se 0 linhas: tenta INSERT; `23505` / duplicate key → `false` (outro tick ganhou).
- Tabela ausente / `permission denied` → `isMissingTableError` trata como sucesso (`true`) para não bloquear o resto. Comportamento a **preservar**, não “corrigir” na modularização.

**CONFIRMADO — assimetria do estágio gestor:** primeiro/crítico fazem claim **antes** do socket. Gestor com WhatsApp ligado só faz claim **depois** de envio ok. Falha de WhatsApp (`whatsapp_falha`) **não** marca `gestor_notificado_em`, então o próximo tick tenta de novo. Mudar essa ordem duplica notificação ou silencia o gestor.

### 5.2 Âncora do ciclo

`resolveAlertaSemRespostaCycleAnchor`: se `estado.ultimo_cliente_msg_em` é posterior à última msg `in` **e** está a ≤ 60 s de `conversas.atendente_atribuido_em`, a âncora é o instante da **assunção** (conversa reaberta pelo alerta e reassumida). Caso contrário, âncora = `ultima.criado_em`.

`resetAlertaSemRespostaAoAssumirReaberta` só reseta se houver evidência de reabertura pelo alerta (`estado.reaberta_em`, `opts.reaberta_falta_interacao_em`, ou coluna `conversas.reaberta_falta_interacao_em`). Patch: zera estágios e `reaberta_em`; **não** apaga eventos.

### 5.3 Horário comercial forçado

Com `alerta_sem_resposta_ativo`, `normalizeAlertaSemResposta` e `resolveAlertaRuntimeConfig` forçam `horario_comercial_ativo: true`. O job **não** conta 24 h com o alerta ligado. Testes cobrem isso.

Fonte da agenda: se o JSON do alerta tem alguma chave `horarioInicio` / `horarioFim` / `horariosJanelas` / `diasSemanaDesativados` / `datasEspecificasFechadas`, usa o alerta; senão cai no `chatbot_triage` (`mergeScheduleSource`).

**CONFIRMADO (preservar, não “consertar” na quebra):** `normalizeAlertaSemResposta` **não persiste** `horariosJanelas` no objeto normalizado. Se o PUT mandar só janelas, elas podem ser descartadas e o merge passa a usar `horarioInicio`/`horarioFim` default. Janelas reais hoje vêm, na prática, do chatbot quando o alerta não tem agenda própria.

---

## 6. Banco, HTTP, sockets, env

### Tabelas (migrations)

- `20260608000000_alerta_atendimento_sem_resposta.sql` — `eventos` + `estado` (PK `company_id,conversa_id`)
- `20260608130000_alerta_sem_resposta_grants.sql` — GRANT service_role (erro clássico: permission denied)
- `20260608150000_alerta_sem_resposta_estado_reaberta.sql` — coluna `estado.reaberta_em`

`getEstado` faz `select('*')`. Não ampliar; na extração, listar colunas explicitamente só se os testes de estado forem atualizados no mesmo PR.

Todas as queries do service filtram `company_id` **CONFIRMADO**. `runAtendimento…ForAllCompanies` itera `empresas` de propósito (job global).

### HTTP

| Rota | Auth no código | Efeito |
|----------------------|----------|
| `GET/PUT /config/alerta-sem-resposta` | `auth` + `supervisorOrAdmin` | leitura/gravação JSON em `ia_config` |
| `GET /config/alerta-sem-resposta/eventos` | idem | lista tenant-scoped |
| `POST /config/alerta-sem-resposta/processar` | idem | processa **só** `req.user.company_id`; `dry_run` no body/query |
| `POST /jobs/atendimento-sem-resposta` | `X-Cron-Secret` | **todas** as empresas |

**CONFIRMADO vs doc 05:** o 05 dizia `PUT/processar AD`. O router `configOperacionalRoutes.js` aplica `supervisorOrAdmin` em **todas** essas rotas, sem `adminOnly`. O 05 foi alinhado a este fato na mesma data deste documento.

### Sockets (não mudar payload)

- `alerta_sem_resposta` → sala `usuario_{atendente}` e, no estágio gestor, também `usuario_{gestor}`
- `alerta_sem_resposta_evento` → `empresa_{company_id}`
- `conversa_atualizada` → `empresa_{company_id}` (reabertura e/ou tags)

### Env

- `ATENDIMENTO_SEM_RESPOSTA_INTERVAL_MINUTES` (1–10, default 1) — só o scheduler
- `ZAPERP_DISABLE_BACKGROUND_JOBS` / `NODE_ENV=test` — não sobe o timer
- SMTP (`SMTP_HOST` / `SMTP_URL` / `MAIL_HOST`) — só **valida** se o canal e-mail pode ser ligado; **não envia**

### Provider

`sendGestorWhatsapp` usa `getProvider().sendText` com `sendOrigin: 'alerta_sem_resposta_gestor'`. Recusar grupo/`lid:`/`120…` longo em `resolveGestorWhatsappDestination`.

---

## 7. Acoplamento perigoso: SLA

[`services/slaCalculationService.js`](../../services/slaCalculationService.js) importa horário comercial **deste** arquivo. Extraír `businessMinutesBetween` / `normalizeBusinessSchedule` / `mergeScheduleSource` / `describeBusinessSchedule` para um módulo compartilhado é o split de **maior valor e menor risco**, desde que:

- a função continue pura (sem `ia_config`);
- o almoço fixo do SLA (`SLA_LUNCH_BREAK`, 12:00–14:00) **permaneça** em `slaCalculationService` — ele **não** entra no alerta;
- `tests/slaCalculationService.test.js` e `tests/atendimentoSemRespostaService.test.js` continuem passando com o mesmo `require` (re-export na fachada).

Não mover o processor junto com o horário comercial.

---

## 8. Vizinho: `helpers/reabertaFaltaInteracaoHelper.js`

Não fundir na pasta nova na 1ª leva. O helper:

- marca badge azul (`reaberta_falta_interacao_em` + `estado.reaberta_em`);
- enriquece a lista de conversas;
- **também** faz upsert em `alerta_atendimento_sem_resposta_estado`.

O service chama `markReabertaFaltaInteracao` depois de `reabrirConversa`. Dois escritores na mesma tabela: qualquer extração de `stateStore` precisa receber o helper como dependência, não o contrário.

---

## 9. Testes hoje vs. o que falta

Suite: [`tests/atendimentoSemRespostaService.test.js`](../../tests/atendimentoSemRespostaService.test.js).

**Coberto (puro):** defaults, ordem/igualdade de minutos, canal obrigatório, e-mail como canal, formatação de tempo, texto WhatsApp sem ID da conversa, horário comercial (pausa, janelas, timezone, empresas distintas, forçar comercial com alerta ativo), âncora pós-assunção, reset patch.

**Não coberto (lacuna CONFIRMADA — grep zero):** `processCompanyAtendimentoSemResposta`, `claimEstadoStage`, `reabrirConversa`, `saveAlertaSemRespostaConfig`, `validateAlertaSemRespostaReferences`, envio WhatsApp, sockets, tag, dry-run vs live, tenant cruzado.

Antes de fatiar o processor: adicionar testes com Supabase mockado para (mínimo):

1. claim perde a corrida → não emite segundo alerta;
2. WhatsApp gestor falha → não grava `gestor_notificado_em`;
3. última mensagem `out` → `clearEstado`, zero ações;
4. empresa A não lê/grava estado da B;
5. `dryRun: true` não chama insert/update.

Sem esses testes, a extração do processor é o passo de maior regressão.

---

## 10. Estrutura proposta (alvo)

Não criar pastas até a 1ª PR aprovada. Alvo sugerido:

```
helpers/businessSchedule.js          ← compartilhado com SLA (slaCalculationService importa daqui)
services/atendimentoSemResposta/
  constants.js                      ← DEFAULT + cor da tag
  errors.js                         ← isMissingTableError, duplicateKeyError
  config.js                         ← normalize/validate/CRUD ia_config
  cycle.js                          ← âncora + reset patch (puros)
  stateStore.js                     ← eventos, estado, claim, revalidate, última msg
  notifications.js                  ← socket, WhatsApp, stub e-mail, textos
  tags.js                           ← ensureTag + fetch para realtime
  reopen.js                         ← reabrirConversa
  processor.js                      ← processCompany + runAll
  index.js                          ← re-exporta a API pública
services/atendimentoSemRespostaService.js  ← shim: module.exports = require('./atendimentoSemResposta')
services/atendimentoSemRespostaScheduler.js  ← permanece onde está
```

**CONFIRMADO (2026-08-31):** essa árvore está no working tree. `require('../services/atendimentoSemRespostaService')` continua válido. SLA importa `helpers/businessSchedule.js` direto. `revalidateConversaElegivel` ficou em `stateStore.js` (precisa de I/O), não em `cycle.js`.

CommonJS, um `module.exports` por arquivo, sem circular require: `processor` → os outros; `config` não importa `processor`; `businessSchedule` não importa o service.

---

## 11. Fases

Executadas juntas em 2026-08-31 (fachada estável, sem migration, sem evento Socket novo). Fase 6 **não** feita.

| Fase | O quê | Status |
|------|--------|--------|
| **0** | Este documento | feito |
| **1** | `helpers/businessSchedule.js`; SLA importa o helper | feito |
| **2** | `config.js` | feito |
| **3** | `stateStore.js` + `cycle.js` | feito |
| **4** | `notifications.js`, `tags.js`, `reopen.js` | feito |
| **5** | `processor.js` + shim | feito — smoke `skipped: inativo` na suite; claim/WhatsApp ainda sem teste de I/O dedicado |
| **6** (opcional) | Encolher exports mortos; `select` explícito; import morto no controller | pendente |

Não implementar SMTP nesta pasta.

---

## 12. Riscos de regressão (checklist da implementação)

- [ ] `company_id` continua só do JWT / loop de `empresas.id` / argumento do job — nunca de body da conversa
- [ ] Claim compare-and-set + insert/23505 iguais
- [ ] Gestor + WhatsApp: claim **depois** do send; falha não avança estágio
- [ ] Alerta ativo ⇒ horário comercial obrigatório
- [ ] Âncora de 60 s após assumir conversa reaberta
- [ ] `clearEstado` quando a última msg não é `in`
- [ ] `isMissingTableError` inclusive `permission denied`
- [ ] Fallback de `reabrirConversa` se a coluna `reaberta_falta_interacao_em` não existir
- [ ] Recusar grupo/lid no destino WhatsApp do gestor
- [ ] E-mail continua stub (`email_indisponivel`)
- [ ] Sockets e payloads inalterados
- [ ] SLA não ganha nem perde o recorte de almoço
- [ ] Shim `atendimentoSemRespostaService.js` não quebra `require` existente
- [ ] Teste negativo tenant A vs B em qualquer query nova

**Não fazer na modularização:** N+1 da última mensagem, índice novo, SMTP real, fundir o helper de badge, alterar limiares default, `SELECT *` “de limpeza” no mesmo PR do processor.

---

## 13. Como testar depois de cada fase

```text
NODE_ENV=test ZAPERP_DISABLE_BACKGROUND_JOBS=1 npx jest tests/atendimentoSemRespostaService.test.js tests/slaCalculationService.test.js --runInBand
```

Manual (homologação, não produção): empresa com alerta ativo, conversa `em_atendimento`, última msg do cliente, esperar o 1º limiar; reassumir conversa reaberta e confirmar que o prazo recomeça; `POST /config/alerta-sem-resposta/processar` com `dry_run: true`.

---

## 14. Dívida que este arquivo já tem (fora da quebra)

| Item | Estado | Não misturar com modularização |
|------|--------|--------------------------------|
| Job percorre todas as `em_atendimento` com N+1 de `mensagens` + `estado` | CONFIRMADO | performance |
| E-mail do gestor não envia | CONFIRMADO | produto |
| `horariosJanelas` no JSON do alerta não sobrevive ao `normalize` | CONFIRMADO | produto/bug separado |
| Processor: só smoke `skipped: inativo` via fachada; claim/WhatsApp/reabrir sem teste de I/O | CONFIRMADO | lacuna residual |
| `getEstado` usa `select('*')` | CONFIRMADO | higiene |
| Import morto `getBusinessScheduleInfo` no controller | CONFIRMADO | higiene |

Existência das tabelas/GRANTs na VPS: **PENDENTE DE VALIDAÇÃO**.
