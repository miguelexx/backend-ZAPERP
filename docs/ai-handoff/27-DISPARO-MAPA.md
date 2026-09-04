# 27 — DISPARO de mensagens: mapa de CÓDIGO

> Criado **2026-09-01** (fecha o gap P0 do [26](26-AUDITORIA-LEGIBILIDADE-CODIGO.md)). Fonte: código atual.
> Aqui é o **mapa de código** (quem chama quem, tabelas, gates, invariantes). Produto/operação ficam
> nos runbooks do repo pai: `DISPARO_MENSAGENS.md`, `DISPARO_GO_LIVE_RUNBOOK.md`,
> `DISPARO_MIGRATIONS_RUNBOOK.md`, `DISPARO_PILOTO_PLAN.md`, `DISPARO_CARGA_E_FALHAS.md`.

Cluster: **~15k linhas / ~40 arquivos** (`controllers/disparo*` + `services/disparo*` + `helpers/disparo*` + `workers/disparoWorker.js`). Rota única: `app.use('/disparo', apiLimiter, disparoRoutes)`. Isolamento por `company_id` do JWT (exceto heartbeat — ver §5).

O código é organizado por **Etapas (3–9)** do produto. Cada arquivo já tem header dizendo sua Etapa; o que faltava era este mapa conectando-os.

---

## 1. Fluxo de runtime (o caminho quente)

```
Campanha criada/revisada (HTTP, Etapas 3–6)
        │  gera fila persistente
        ▼
disparoFilaService.gerar*      → tabela disparo_fila_itens (1 linha por destinatário×variação)
        │
        ▼   (loop assíncrono)
workers/disparoWorker.js  ── heartbeat ──► disparo_worker_heartbeat
   1) recuperarLeases()      → RPC disparo_recuperar_leases_expirados  (libera itens de worker morto)
   2) claimItens()           → RPC disparo_claim_fila_itens (LEASE: só 1 worker pega o item)
   3) por item:
        gate podeEnviarAgora()  (disparoLimitesRuntime)  ── se não ── adiarItem() e segue
        tryLockInstancia()      (1 envio por instância por vez)
        enviarItemFila()        → services/disparoSendService.js → provider (UltraMSG)
        recalcularContadores()  (disparoFilaService)  + emitDisparo() (socket)
        │
        ▼  (mais tarde, assíncrono)
UltraMSG ACK  → webhookZapiController.statusZapi → disparoWebhookHook.aplicarStatusDisparoFromWebhook
                                                   (atualiza status do item na fila, sem regredir)
Resposta inbound do destinatário → disparoRespostaService (vincula) / disparoOptOutService (sair)
```

**Etapa 8 (pós-envio):** `disparoOptOutService` (opt-out/reativação), `disparoRespostaService` (vincular
resposta ao item), `disparoReconciliacaoService` (decidir itens **incertos** manualmente),
`disparoRelatorioService` (relatório final). Controller: `disparoEtapa8Controller`.

---

## 2. Os GATES (não relaxar)

| Gate | Onde | Efeito |
|------|------|--------|
| `WORKER_ENABLED` | env / `disparoWorkerConfig` | **false** → worker vive só com heartbeat, **não** claima fila. Default do repo: worker embutido na API ligado. |
| `LIVE_ENABLED` + `DRY_RUN=false` | env / `workerPodeProcessarExecucao` | envio **real** só com os dois; senão simula. `DISPARO_LIVE_ENABLED=false` por padrão. |
| **Lease** | RPC `disparo_claim_fila_itens` (`lease_seconds`) | só 1 worker processa cada item; lease expirado é recuperado por `disparo_recuperar_leases_expirados`. Não processar item sem claim. |
| Limite/janela | `disparoLimitesRuntime.podeEnviarAgora` | respeita limites por empresa/instância e janelas de horário; item volta para `adiarItem` com `proxima_tentativa_em`. |
| Anti-reenvio incerto | `disparoSendService` (`provider_message_id`) | item que já tem `provider_message_id`/`enviado_em` → marca **incerto**, não reenvia cego (evita duplicar no cliente). |

---

## 3. Índice de arquivos por Etapa

**Controllers (`/disparo/*`, HTTP CRUD):**
| Arquivo | LOC | Etapa / papel |
|---|--:|---|
| `disparoController.js` | — | entrada geral do módulo (CRUD campanha, **DELETE** exclui com `company_id`; bloqueia `em_execucao`) |
| `disparoInstanciasController.js` | 940 | **3** — instâncias da campanha |
| `disparoVariacoesController.js` | 985 | **4** — variações de mensagem (spintax/anti-spam) |
| `disparoLimitesController.js` | 1.200 | **5** — limites por empresa/instância/janela |
| `disparoRevisaoController.js` | 1.511 | **6** — revisão final (checklist) |
| `disparoExecucaoController.js` | 1.174 | **7** — start/pause/stop da execução |
| `disparoDestinatariosController.js` | 665 | **7** — destinatários (import planilha/ZIP) |
| `disparoExclusaoController.js` | 288 | **7** — exclusões (opt-out manual/listas) |
| `disparoEtapa8Controller.js` | 637 | **8** — opt-out, respostas, reconciliação, relatório, export |
| `disparoSaudeController.js` | 29 | **9** — saúde operacional (admin-only) |

**Services (regra/estado):**
| Arquivo | LOC | Papel |
|---|--:|---|
| `disparoFilaService.js` | 640 | gera a fila (`disparo_fila_itens`), contadores, eventos |
| `disparoSendService.js` | 499 | **envia 1 item** via provider; anti-reenvio incerto |
| `disparoLimitesRuntime.js` | 185 | gate de limites/janela em tempo de envio |
| `disparoWebhookHook.js` | 281 | ACK UltraMSG → status do item (chamado pelo `statusZapi`) |
| `disparoRespostaService.js` | 315 | vincula resposta inbound ao item |
| `disparoOptOutService.js` | 404 | opt-out inbound + reativação |
| `disparoReconciliacaoService.js` | 518 | reconciliação manual de itens incertos |
| `disparoRelatorioService.js` | 460 | relatório pós-campanha |
| `disparoConversaOrigemService.js` | 357 | marca a conversa como originada de campanha |
| `disparoSocketService.js` | 35 | eventos Socket.IO do módulo |
| `disparoRetencaoService.js` | 88 | retenção de dados (Etapa 9) |

**Worker + helpers-chave:** `workers/disparoWorker.js` (781 — loop/claim/lease/gates), `helpers/disparoLimitesHelper.js` (804 — cálculo de limites), `helpers/disparoWorkerHealth.js` (187), `helpers/disparoFilaRetryHelper.js` (117 — classificação de erro + backoff), `helpers/disparoRevisaoChecklist.js` (346), `helpers/disparoPlanilhaHelper.js`/`disparoZipInspector.js` (import), `helpers/disparoObservabilidade.js` (87).

---

## 4. Tabelas (18) — Supabase

Campanha/config: `disparo_campanhas`, `disparo_empresa_config`, `disparo_campanha_instancias`,
`disparo_campanha_instancia_limites`, `disparo_campanha_limites`, `disparo_campanha_janelas`,
`disparo_campanha_variacoes`, `disparo_campanha_destinatarios`, `disparo_campanha_revisoes`,
`disparo_exclusoes`, `disparo_pausas`.
Execução: `disparo_execucoes`, `disparo_execucao_eventos`, **`disparo_fila_itens`** (a fila),
`disparo_worker_heartbeat`.
Etapa 8: `disparo_optout_eventos`, `disparo_respostas`, `disparo_reconciliacao_decisoes`.

RPCs (Postgres): `disparo_claim_fila_itens`, `disparo_recuperar_leases_expirados`.

---

## 5. Invariantes e riscos abertos

- **Isolamento por `company_id`** em toda query — SERVICE_ROLE bypassa RLS.
- **Vulnerabilidade conhecida (não ampliar):** `disparoSaudeController` / `disparo_worker_heartbeat`
  são consultados **sem filtro `company_id`** → expõe metadados operacionais cross-tenant. Ver `CLAUDE.md` e [13](13-PROBLEMAS-CONHECIDOS-E-DIVIDA-TECNICA.md).
- **PM2 `instances: 1`** (`ecosystem.config.js`) — o lease protege contra duplo-claim, mas ainda não há
  coordenação distribuída; não subir réplicas do worker sem isso.
- Não unificar `crm-*` (eco fromMe do CRM) com `disp-*`/wamid (itens de disparo) — chaves distintas (ver [24](24-WEBHOOK-INBOUND-MODULARIZACAO.md)).
- Testes-gate do cluster: `disparoFilaService`, `disparoSendService`, `disparoUltramsgReferenceId`,
  `disparoIsolamentoEmpresas`, `disparoLeaseRecovery`, worker/lease/retry. (Set/2026: alguns mocks de
  supabase da suíte de disparo divergem — `.not` ausente no chain; ver [26](26-AUDITORIA-LEGIBILIDADE-CODIGO.md).)

---

## 6. Como um AI deve navegar o DISPARO
1. Este mapa (§1 fluxo + §3 índice). 2. Runbooks de produto (repo pai) para o "porquê". 3. Só então o
código: comece pelo `disparoWorker.js` (runtime) ou pelo controller da Etapa que você vai mexer.
Não modularizar sem antes ler os gates (§2) e o anti-reenvio incerto — quebrar isso duplica mensagem no cliente.
