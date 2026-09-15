# 28 — Múltiplos números WHAPI por empresa (feed unificado)

> Criado: **2026-09-12**. Autor: sessão de análise + organização.
> Objetivo: permitir que **uma empresa conecte vários números WHAPI** e todos apareçam no mesmo ZapERP,
> mantendo o sistema unificado, identificando por qual número cada mensagem chegou e respondendo pelo canal correto.
> **Sem mexer no que já está correto.** Aditivo, compatível com empresas de 1 número.
>
> Estados: **CONFIRMADO** = li no código/migration nesta base · **PENDENTE DE VALIDAÇÃO** = depende do banco/deploy real, não inspecionável daqui.
>
> Relacionados: [`25-WHAPI-SEGUNDA-INTEGRACAO.md`](25-WHAPI-SEGUNDA-INTEGRACAO.md) (a 2ª integração, base deste trabalho) ·
> [`26-WHAPI-TRIAGEM-INTERATIVA.md`](26-WHAPI-TRIAGEM-INTERATIVA.md) · [`03-BANCO-DE-DADOS.md`](03-BANCO-DE-DADOS.md) ·
> [`06-WHATSAPP-ULTRAMSG-E-WEBHOOKS.md`](06-WHATSAPP-ULTRAMSG-E-WEBHOOKS.md) · [`07-SOCKET-IO-E-TEMPO-REAL.md`](07-SOCKET-IO-E-TEMPO-REAL.md).

---

## 0. Conclusão em uma frase (ler antes de tudo)

**A arquitetura multi-número já existe e está quase toda construída.** A fundação multi-instância
(`whatsapp_instances` + `conversas.whatsapp_instance_id` + `mensagens.whatsapp_instance_id` + roteamento
por instância no inbound/outbound/disparo) é **provider-agnóstica** — "vários números WHAPI numa empresa"
cai exatamente no modelo que já roda em produção para a UltraMSG. Isto **não é um projeto do zero**; é a
**finalização e ativação** de algo desenhado junto com a 2ª integração (doc 25).

O trabalho real que sobra é **estreito**: (1) aplicar migrations + deploy, (2) liberar o provisionamento
de **mais de um** canal WHAPI por empresa, (3) acabamento de UX (identificar/filtrar por número),
(4) backfill de conversas legadas. Nada disso exige tocar o miolo que já funciona.

> **Estado 2026-09-14:** (1) ✅ migrations aplicadas no banco real (§11); (4) ✅ backfill + merge aplicados
> (0 conversas NULL); (2) ✅ multi-canal (§12); (3) UX ✅ **completa** — badge (dormente) + adicionar número +
> renomear/desativar + **filtro por número** (§13). **Tudo codado; falta só deploy** (backend `master` + frontend `main`).
> Pendente menor: teste do `provisionWhapiInstance` (§14 #3) e sync company-level por instância (§4.3). Resumo em §7.

---

## 1. Como funciona hoje (CONFIRMADO no código)

### 1.1 Modelo de instâncias — `whatsapp_instances`

Tabela criada em [`20260615000000_whatsapp_instances_phase1.sql`](../../supabase/migrations/20260615000000_whatsapp_instances_phase1.sql).

| Coluna | Papel |
|---|---|
| `company_id` | Tenant |
| `provider` | `ultramsg` \| `whapi` (CHECK; `whapi` liberado na migration `20260904120000`) |
| `instance_id` | UltraMSG `instanceXXXXX` **ou** channel id Whapi (`NEBULA-AER3B`) |
| `instance_token` | token/Bearer sensível (nunca expor) |
| `client_token` | UltraMSG; `NULL` na Whapi |
| `ativo`, `is_default`, `status`, `telefone_conectado`, `display_phone` | estado/saúde |

- **N linhas por empresa** já suportadas. Índice único `uq_whatsapp_instances_default_active` = **1 default por empresa** (entre todos os providers).
- Índice único `uq_whatsapp_instances_company_provider_instance` = não repete o mesmo `(company, provider, instance_id)`.
- `empresa_zapi` permanece como **legado/fallback** (não apagar). Backfill inicial cria 1 instância default a partir de cada `empresa_zapi` ativa.

Serviço canônico: [`services/whatsappInstanceService.js`](../../services/whatsappInstanceService.js) — **já parametrizado por provider em todas as queries**. Funções-chave:
- `listWhatsappInstances(company)` · `getWhatsappInstanceById` · `getWhatsappInstanceByProviderInstanceId(provider, id)` (filtra `.eq('provider', p)`).
- `getDefaultWhatsappInstance(company, { provider })` — default explícito → 1 ativa → legado `empresa_zapi`; 2+ ativas sem default exige escolha em produção (`NO_DEFAULT_INSTANCE`).
- `resolveWhatsappInstanceForManualAction(company, id?)` — nova conversa: id explícito → valida; 1 ativa → adota; 2+ → `SELECIONE_WHATSAPP_INSTANCE`.
- `createWhatsappInstance` — **aceita múltiplas**; 1ª Whapi numa empresa com default UltraMSG **não** vira default (guarda cross-provider).

### 1.2 Recebimento (inbound) — já carimba o número

Rota `POST /webhooks/whapi` → stack em [`routes/webhookWhapiRoutes.js`](../../routes/webhookWhapiRoutes.js):
`webhookLogger → webhookBodyResolver → requireWhapiWebhookToken → resolveWhapiWebhookCompany → handleWebhookWhapi`.

1. [`middleware/resolveWhapiWebhookCompany.js`](../../middleware/resolveWhapiWebhookCompany.js): `channel_id` →
   `getWhatsappInstanceByProviderInstanceId('whapi', channelId)` → injeta `req.zapiContext` com
   `company_id`, `whatsapp_instance_id`, `provider:'whapi'`. **Tenant sempre pela instância, nunca do payload.**
2. [`controllers/webhookWhapiController.js`](../../controllers/webhookWhapiController.js): normaliza `messages[]`/`statuses[]` para o formato interno e delega ao **mesmo núcleo** `receberZapi`/`statusZapi`.
3. [`controllers/webhookZapiController.js`](../../controllers/webhookZapiController.js) (nome legado, handler ATIVO) carrega `whatsapp_instance_id` em **todo** o caminho:
   - Tenant: [`webhookInbound/instanceResolve.js`](../../controllers/webhookInbound/instanceResolve.js) (não re-resolve como ultramsg quando o contexto já traz company_id — o caso Whapi).
   - Busca/criação de conversa e mensagem **filtradas por instância** (`applyWhatsappInstanceFilterOrLegacy`); `findOrCreateConversation` recebe `whatsapp_instance_id` + `whatsapp_instance_is_default`.

### 1.3 Conversa por número — o "unificado mas identificado"

Migrations [`20260615005000`](../../supabase/migrations/20260615005000_whatsapp_instances_conversas_unique.sql)
e [`20260615120000`](../../supabase/migrations/20260615120000_conversas_open_unique_multi_instance.sql):

- `idx_conversas_company_instance_telefone_unique` em `(company_id, whatsapp_instance_id, telefone)`
  → **o mesmo cliente tem conversas separadas por número da empresa**, sem colidir.
- `idx_conversas_company_instance_telefone_open_unique` → **1 conversa aberta** por (empresa, número, telefone).
- `idx_conversas_company_instance_chat_lid_unique` → isola `chat_lid` por instância.
- Idempotência de mensagem por `(company_id, whatsapp_instance_id, whatsapp_id)`
  ([`20260615003000`](../../supabase/migrations/20260615003000_whatsapp_instances_phase2_1_messages_unique.sql)).
- **Índices `*_legacy_null_unique`** preservam empresas de 1 número (onde `whatsapp_instance_id` ainda é NULL) — compatibilidade byte-a-byte.

### 1.4 Envio (outbound) — sai pelo número da conversa

[`services/chat/identity/conversationAddressService.js`](../../services/chat/identity/conversationAddressService.js):
- `resolveConversationWhatsappInstance(company, conversa)` → se a conversa já tem `whatsapp_instance_id`, usa; senão amarra a instância inequívoca (default ou única) e **persiste** o vínculo (só quando era NULL).
- `resolveConversationProvider(company, instanceId)` → `'whapi'`/`'ultramsg'` → `getProvider({ provider })`.

Os **12 controllers de chat** já usam esse par (texto, mídia, reação, forward, edit, delete, retry, contato, grupo, presença, etc.):
`mediaMessageController`, `textMessageController`, `outboundController`, `forwardController`, `messageEditController`,
`retryController`, `contactController`, `groupAdminController`, `messageDeletionController`, `attendanceController`,
`presenceController`, `integrationController`. **A resposta sempre sai pelo número em que a conversa está.**

### 1.5 Campanhas / disparo — por instância

[`services/disparoSendService.js`](../../services/disparoSendService.js): roteia por `item.instancia_id` +
`resolveConversationProvider` + `getProvider({ provider })`. Fila, `whatsappSendGuardService` e o gate anti-ban
([`disparoAntibanGuardService.js`](../../services/disparoAntibanGuardService.js), doc 25 §31) são **por instância**.

### 1.6 Tempo real — já unificado

Sala `empresa_{company_id}` (doc 07). **Todos os números de uma empresa já caem num único feed** em tempo real.
Eventos `nova_mensagem`/`status_mensagem`/`atualizar_conversa` não precisam mudar — o normalizador entrega o mesmo
formato interno independentemente do provider/número.

### 1.7 Painel de administração — já por instância

[`controllers/whatsappIntegrationController.js`](../../controllers/whatsappIntegrationController.js):
status/QR/logout/configure-webhooks/business-profile/presence/limits **por instância**; lista múltiplas;
provisionamento Whapi via Partner API (`provisionWhapiInstance`).

---

## 2. O que pode ser reaproveitado

| Camada | Estado | Reuso |
|---|---|---|
| Schema multi-instância (migrations escritas) | CONFIRMADO escrito | 100% |
| Roteamento inbound por `channel_id` | CONFIRMADO | 100% |
| Conversa/mensagem chaveada por instância | CONFIRMADO | 100% |
| Envio pelo canal correto da conversa (12 controllers) | CONFIRMADO | 100% |
| Disparo por instância | CONFIRMADO | 100% |
| Socket unificado por empresa | CONFIRMADO | 100% |
| Adapter Whapi (124+ métodos, testado) | CONFIRMADO | 100% |
| Painel admin por instância | CONFIRMADO | ~90% |
| Frontend (store/service de instâncias, modal de nova conversa) | Parcial | reaproveitável |

Suíte ~1742 testes verdes (doc 25 §33). Zero regressão reportada na UltraMSG.

---

## 3. O que está CORRETO e NÃO deve ser alterado

Herdado de doc 25 §9 + esta análise:

- ❌ Não editar/refatorar a UltraMSG (`services/providers/ultramsg*`, `webhookUltramsgController`, `ultramsgIntegration*`, rotas ultramsg, alias `/webhooks/whatsapp`).
- ❌ Não unificar adapter, JID ou normalizador num "provider genérico". Whapi tem `config.js`/`phones.js` próprios.
- ❌ Não tornar `getProvider()` sem-arg nada além de UltraMSG (invariante travada por teste).
- ❌ Não mover/renomear `receberZapi`/`statusZapi` nem o arquivo `webhookZapiController.js`.
- ❌ Não inventar `referenceId` na Whapi; não misturar id numérico de fila (UltraMSG) com wamid (Whapi).
- ❌ Não tocar o sistema de scroll/teclado mobile nem as barras sticky do frontend (ver CLAUDE.md).
- ❌ `company_id` nunca de body/query; auth de webhook nunca por `?token=`.

---

## 4. Limitações mapeadas na análise (com o estado ATUAL de cada uma)

> Esta seção nasceu como "o trabalho real". Atualizada 2026-09-14 com o que já foi resolvido.

### 4.1 Provisionamento self-serve criava só 1 canal por empresa — ✅ RESOLVIDO (Etapa 2, §12)
Era: `provisionWhapiInstance` idempotente (`pickExistingWhapiInstance` recusava o 2º). Agora aceita a flag
`novo:true` → cria canal adicional (com teto e nome distinto). Sem a flag, comportamento idêntico ao de hoje.

### 4.2 Frontend por número — ✅ badge PRONTO (dormente) · ⏳ falta só o filtro
Correção da análise inicial: o **badge "qual número"** e o rótulo no cabeçalho **já existem e são testados**
(`ChatListRow.jsx`, `useConversationHeaderIdentity.js`), apenas dormentes até `hasMultiple` (§13). O **botão
"adicionar número"** também já está codado (§13). Falta apenas o **filtro por número** na lista. O seletor de número
ao **iniciar** conversa nova já existia (`SELECIONE_WHATSAPP_INSTANCE` + `NovoContatoModal.jsx`).

### 4.3 Sync company-level escolhe uma instância — ⏳ em aberto (impacto baixo)
Sync de contatos/fotos/grupos usa `pickCompanyWhatsappInstance` (uma instância). Com vários números, o sync
deveria rodar **por instância** para cobrir todos. Envio/recebimento não dependem disso.

### 4.4 Overlay vermelho “WhatsApp DESCONECTADO” com 2+ canais — ✅ CORRIGIDO (2026-09-15)
`GET /chats/whapi-status` (`whapiChannelStatus`) consultava só `getConnectionStatus({ companyId })`.
Em produção, 2+ Whapi **sem** `is_default` devolve `NO_DEFAULT_INSTANCE` → `connected:false` → tela vermelha
mesmo com todos AUTH (o painel Configurações hidrata por `whatsappInstanceId` e mostrava Conectado).
Agora o endpoint lista os canais Whapi ativos e consulta cada um; overlay só se **todos** estiverem
comprovadamente fora do AUTH. Um AUTH (ou erro de consulta) → `connected:true`.

---

## 5. Riscos

- **✅ Migrations + deploy — CONFIRMADO APLICADO (2026-09-12).** Diagnóstico no banco real (ver §11) mostra:
  `whatsapp_instances_provider_chk` = `CHECK (provider = ANY ('ultramsg','whapi'))`; `conversas`/`mensagens` têm
  `whatsapp_instance_id`; **os 8 índices multi-instância existem**; 2 empresas já usam Whapi ao vivo (código deployado).
  **A fundação multi-número está 100% no banco — nada de migration de fundação a aplicar.** A ordem obrigatória
  continua valendo para QUALQUER migration futura (ex.: backfill): **migration → deploy → cadastrar instância → apontar webhook**.
- **🔴 14.384 conversas com `whatsapp_instance_id` NULL + risco cross-número (risco #1 agora).** Enquanto a empresa
  tem 1 número, NULL é inofensivo. Mas o inbound casa conversa por `instância = X OU instância NULL` (compat. legado,
  `applyWhatsappInstanceFilterOrLegacy`). No instante em que a empresa ganha o **2º número**, uma mensagem que chega
  pelo número B pode cair numa conversa antiga que era do número A (porque está NULL) → resposta sai pelo canal errado.
  **Mitigação obrigatória: carimbar (backfill) as conversas NULL da empresa ANTES de ativar o 2º número dela.**
  Hoje **nenhuma empresa tem 2+ instâncias ativas** (§11) → dá para backfillar as 14.384 com segurança total agora
  (cada conversa NULL recebe a **única instância ativa** da sua empresa — sem ambiguidade de origem).
- **🟠 Mesmo número em duas APIs = duplicação.** Registrar o mesmo telefone em dois canais (ou UltraMSG+Whapi)
  faz ambos entregarem webhook → mensagens duplicadas. Sem trava de banco (por design, números são distintos).
  Regra operacional a reforçar na UI de cadastro.
- **🟡 Reconciliação Whapi sem `referenceId`.** Eco `from_me` casa por `whatsapp_id` síncrono. Se o
  `POST /messages/text` responder `sent:true` **sem** `message.id`, a linha fica `pending` e pode reenviar (doc 25 §33). Raro.
- **🟡 Estado em memória / processo único** (sem Redis). Mais números = mais carga num processo só. Observar, não bloqueia.

---

## 6. Arquitetura recomendada

**Manter exatamente o modelo existente** — é o mais seguro, simples e escalável, e já validado por testes:

> Uma linha em `whatsapp_instances` por número WHAPI da empresa. O inbound carimba `whatsapp_instance_id` na
> conversa pelo `channel_id`. Conversa chaveada por `(company_id, whatsapp_instance_id, telefone)`. A resposta sai
> pelo `whatsapp_instance_id` da conversa. Feed único por `empresa_{company_id}` no socket.

Não criar tabelas paralelas, não unificar adapters, não tocar o miolo da UltraMSG. Aditivo; preserva empresas de 1 número.

---

## 7. Plano por etapas seguras (com gate de pronto)

| Etapa | Escopo | Estado | Gate de pronto |
|---|---|---|---|
| **0 — Verificação** (sem código) | Confirmar schema/deploy no banco real | ✅ **FEITO 2026-09-12** (§11) | Ponto de partida conhecido |
| **1 — Banco + deploy** | Migrations de fundação + deploy do código Whapi | ✅ **JÁ APLICADO** (§11) | Whapi recebe/envia ao vivo (2 empresas) |
| **3 — Backfill legado + merge das duplicatas** | Merge das 59 duplicatas ([`scripts/merge_conversas_null_duplicadas.sql`](../../scripts/merge_conversas_null_duplicadas.sql)) + backfill ([`20260912120000_...sql`](../../supabase/migrations/20260912120000_backfill_conversas_mensagens_whatsapp_instance_id.sql)) | ✅ **APLICADO 2026-09-12** (`conversas_null_restantes = 0`) | ✅ Nenhuma conversa NULL — toda conversa amarrada a um número |
| **2 — Multi-canal no provisionamento** | Liberar 2º+ canal WHAPI por empresa (`provisionWhapiInstance`) | ✅ **código pronto 2026-09-12** (aguarda deploy) | 2 números ativos, webhooks distintos resolvendo cada instância |
| **4 — UX unificada** | Badge "qual número" ✅ (dormente) · botão "adicionar número" ✅ · renomear/desativar ✅ · **filtro por número** ✅ (§13) | ✅ **código pronto** (aguarda deploy) | Atendente vê e filtra por número num feed único |
| **5 — Sync por instância + homologação live** | Sync de contatos/fotos por número; teste ao vivo com teto/allowlist | ⏳ | Cobertura por número; homologação com autorização |

**Reordenação importante:** o **backfill (3)** passou a ser **pré-requisito da ativação multi-canal (2)** por empresa —
ver risco #1 em §5. Não ative o 2º número de uma empresa antes de carimbar as conversas NULL dela.

**Ordem de execução recomendada da Etapa 3 (aplicar com autorização — Miguel só roda SQL no Supabase Editor):**
1. **Mesclar as 59 duplicatas** primeiro (resolve os conflitos, deixa o backfill com 0 pulos):
   SQL puro transacional [`scripts/merge_conversas_null_duplicadas.sql`](../../scripts/merge_conversas_null_duplicadas.sql).
   Preserva histórico (reaponta mensagens/atendimentos/histórico/avaliações/logs → canônica), descarta estado da
   duplicata (tags/prefs/unreads/atendentes), remove as cascas. Tudo-ou-nada (BEGIN/COMMIT). Casca vazia → removida;
   2 com histórico (empresa 14) → mensagens migram para a carimbada. Rodar em baixa demanda; conferir as 2 depois.
2. **Aplicar o backfill** [`20260912120000_backfill_...sql`](../../supabase/migrations/20260912120000_backfill_conversas_mensagens_whatsapp_instance_id.sql):
   carimba as ~14.325 restantes + as mensagens reapontadas no passo 1.
3. Conferir: `conversas WHERE whatsapp_instance_id IS NULL` deve cair para ~0 nas empresas alvo.

Cada etapa deve: rodar a suíte (gate UltraMSG + Whapi verdes), preservar o caminho legacy-null, e atualizar este doc.

---

## 8. Inventário de migrations relevantes (estado = ✅ APLICADAS no banco real, CONFIRMADO 2026-09-12)

Todas **escritas** em `supabase/migrations/` e **aplicadas** no banco real (evidência: CHECK com `whapi`, colunas e
os 8 índices presentes — §11). O ledger `supabase_migrations.schema_migrations` **não existe** nesse projeto
(migrations aplicadas manualmente), por isso a verdade é o schema, não o ledger.

| Migration | O que faz | Crítica p/ multi-número |
|---|---|---|
| `20260615000000_whatsapp_instances_phase1.sql` | Cria `whatsapp_instances`; add `whatsapp_instance_id` em conversas/mensagens/webhook_logs; backfill de `empresa_zapi` | **Sim** |
| `20260615001000_..._phase1_1_hardening.sql` | Endurecimento phase 1 | Sim |
| `20260615002000_..._phase2_operational.sql` | Campos operacionais | Sim |
| `20260615003000_..._phase2_1_messages_unique.sql` | Idempotência mensagem por `(company, instância, whatsapp_id)` + legacy-null | **Sim** |
| `20260615004000_reload_postgrest_schema_cache.sql` | Reload do cache PostgREST | Suporte |
| `20260615005000_..._conversas_unique.sql` | Unicidade conversa por `(company, instância, telefone/chat_lid)` + legacy-null | **Sim** |
| `20260615120000_conversas_open_unique_multi_instance.sql` | 1 conversa **aberta** por (company, instância, telefone) | **Sim** |
| `20260904120000_whatsapp_instances_provider_whapi.sql` | CHECK aceitar `provider='whapi'` | **Sim (sem ela, cadastrar Whapi falha)** |

---

## 9. O que a próxima sessão deve verificar / decidir

1. **[Etapa 0]** Estado real das migrations e do deploy na VPS (bloqueia tudo).
2. Decisão de produto: provisionar N canais WHAPI self-serve vs cadastro manual assistido (Etapa 2).
3. Backfill: rodar como script único ou deixar a resolução preguiçosa amarrar ao default (Etapa 3).
4. UX: badge por número na lista — usar `display_phone`/`nome` da instância; filtro como aba ou dropdown (Etapa 4).
5. Homologação live: tenant/números de teste, teto e allowlist; rotacionar tokens após (doc 25 §8).

---

## 11. Diagnóstico do banco real (CONFIRMADO 2026-09-12)

Query read-only (10 linhas `item | resultado`) executada no Supabase de produção do ZapERP:

| item | resultado |
|---|---|
| `whatsapp_instances_existe` | `true` |
| `empresa_zapi_existe` | `true` (legado ativo) |
| `provider_check_def` | `CHECK (provider = ANY (ARRAY['ultramsg','whapi']))` → **Whapi liberado** |
| `conversas_tem_instance_id` | `true` |
| `mensagens_tem_instance_id` | `true` |
| `indices_multi_instancia` | **8/8 presentes** (conversas telefone/open/chat_lid + legacy-null; mensagens whatsapp_id + legacy-null; whatsapp_instances default_active + company_provider_instance) |
| `instancias_por_provider` | `ultramsg: 20 ativas / 20 total` · `whapi: 2 ativas / 2 total` |
| `empresas_com_2mais_instancias_ativas` | **0** (multi-número ainda não exercido) |
| `empresas_com_instancia_whapi_ativa` | `2` |
| `conversas_sem_whatsapp_instance_id` | **14.384** (backfill — ver risco #1 §5) |

**Interpretação:** fundação multi-número 100% aplicada e provider Whapi já em produção.

**✅ Etapa 3 APLICADA (2026-09-12):** merge das 59 duplicatas + backfill executados no banco real via SQL Editor.
`conversas_null_restantes = 0` — **toda conversa está amarrada a um número**. Banco pronto para ativar 2º número
por empresa (Etapa 2). Conferir cosmético das 2 conversas com histórico da empresa 14 (tels …978060 e …706126).

**Preview do backfill (read-only, 2026-09-12):** 14.384 NULL em 20 empresas; **0** sem instância ativa; **0** com 2+
ativas → todas backfilláveis à instância única. **59 conflitos de telefone** (conversa NULL cujo telefone já tem
conversa carimbada na mesma instância = duplicata legada) — a migration **pula** essas 59; **0 conflitos de chat_lid**.
As 59 são candidatas a merge/limpeza (inspecionar antes; não apagar às cegas — têm histórico).

---

## 12. Etapa 2 — multi-canal no provisionamento (código pronto 2026-09-12, aguarda deploy)

**Arquivo:** [`controllers/whatsappIntegrationController.js`](../../controllers/whatsappIntegrationController.js) → `provisionWhapiInstance`.
**Mudança aditiva** (sintaxe validada com `node --check`; zero regressão para quem usa 1 número):

- Nova flag no body: `novo: true` (aliases `forceNew` / `adicionar`) → **não** reaproveita o canal Whapi existente; cria um **adicional** via Partner. **Sem a flag, o comportamento é idêntico ao de hoje** (idempotente por empresa — a UI atual não muda).
- **Teto de segurança** `WHAPI_MAX_CHANNELS_PER_COMPANY` (env, default **5**): com `novo:true`, se a empresa já tem N canais Whapi, responde `409 WHAPI_MAX_CHANNELS`. Rede contra criação em excesso (cada canal Partner custa).
- **Nome distinto** por canal: quando a empresa já tem Whapi, o nome default vira `ZapERP empresa {id} #{n+1}` (evita nome repetido no Partner).

**Contrato da rota** (inalterado no path): `POST /integrations/whatsapp/instances/provision-whapi`
- Body `{}` (ou sem `novo`) → devolve o canal existente (`created:false`) — **como hoje**.
- Body `{ novo: true, nome?: "Vendas" }` → cria e devolve um canal novo (`created:true`) + configura webhook. O front mostra o QR para conectar o novo número.

**Por que é seguro:** cada canal Partner tem `instance_id` único → sem colisão de duplicidade; o 2º canal **não** vira default (guarda cross-provider em `createWhatsappInstance`); o webhook de cada canal resolve por seu próprio `channel_id`. Sem migration, sem evento socket novo.

**Falta (Etapa 4, frontend):** botão "adicionar número" no painel Whapi que chama a rota com `{ novo: true }`, e o badge/filtro por número no atendimento. Zona de lista/thread é sensível — planejar isolado.

---

## 13. Etapa 4 — frontend (análise 2026-09-12, verificada no código)

**Grande parte já está construída e testada, apenas DORMENTE** — acende sozinho quando a empresa passa a ter
2+ números ativos (`useWhatsappInstancesStore().hasMultiple`, alimentado por `GET /chats/whatsapp-instances`
→ `has_multiple_whatsapp_instances`). Como nenhuma empresa teve 2 números até agora, essa UI nunca acendeu.

### ✅ Já pronto (nada a codar — só validar ao vivo com 2 números)
- **Badge "qual número" na lista de conversas:** `frontend/src/chats/ChatListRow.jsx` (~1334, `whatsappInstanceLabel`)
  + `ChatListRows.jsx` (passa `showWhatsappInstanceUi = hasMultiple`). Rótulo via `whatsappInstanceLabel(inst)`
  (`nome || display_phone`).
- **Rótulo do número no cabeçalho da conversa:** `frontend/src/conversa/hooks/useConversationHeaderIdentity.js`.
- **Backend já envia a meta por conversa:** `controllers/chat/conversationListController.js` anexa `whatsapp_instance_id`
  + `whatsapp_instance_nome`/`display_phone` (`safeWhatsappInstanceMeta`); `services/chat/presentation/chatDto.js`.
  Testes: `tests/whatsappMultiInstanceAtendimento.test.js`, `tests/whatsappInstancesAtendimentoApi.test.js`.
- **Escolher número ao criar conversa nova:** `NovoContatoModal.jsx` + `resolveWhatsappInstanceForManualAction`
  (code `SELECIONE_WHATSAPP_INSTANCE`).

### ✅ Botão "adicionar número" — FEITO (frontend, 2026-09-14; aguarda deploy)
- `frontend/src/pages/WhapiConnectPanel.jsx`: campo "Nome do novo número" + botão **"+ Adicionar número"** no card
  de números (visível só quando `partnerEnabled && !empty`). `handleAdicionarNumero` chama `provisionarInstanciaWhapi({ nome, novo: true })`,
  seleciona o novo canal e mostra o QR. Trata `WHAPI_MAX_CHANNELS` (409) e `WHAPI_PARTNER_OFF` (503 → abre cadastro avançado).
- `frontend/src/api/whapiInstancesService.js`: `provisionarInstanciaWhapi({ nome, novo })` envia `novo:true` (aditivo).
- Fora das zonas de perigo (é o painel de conexão). Sem socket/migration.

### Filtro por número na lista

**✅ Backend FEITO (2026-09-14, aguarda deploy):** query `whatsapp_instance_id` aceita e aplicada de forma consistente
na **listagem e nos contadores** (senão a aba diverge da lista):
- `services/chat/read/listarConversasFilters.js` — parse `filtroWhatsappInstanceId` (int>0; escopo, vale com busca).
- `controllers/chat/conversationListController.js` — `buildQuery` aplica `.eq('whatsapp_instance_id', …)` logo após `company_id`.
- `services/chatListCountsService.js` — `resolveChatListCountsContext` lê o param, `applyChatListSqlFilters` aplica no
  mesmo chokepoint do `company_id`, e `buildCountsCacheKey` inclui o número (cache não mistura filtros). `node --check` OK.

**✅ Serviço frontend FEITO:** `frontend/src/chats/chatService.js` (`fetchChats` + `fetchChatCounts`) envia
`whatsapp_instance_id` quando ≠ "todos" (aditivo).

**✅ UI FEITA (2026-09-14, aguarda deploy) — seletor de número visível só quando `hasMultiple`**, espelhando o
`atendenteFilter` em TODOS os pontos (validado por esbuild/`node --check`):
1. `hooks/useChatListFilterState.js` — estado `whatsappInstanceFilter` ("todos") + `handleWhatsappInstanceFilterChange` +
   incluído no `buildChatListFilterRequestKey` (request **e** base key) → recarrega ao trocar de número.
2. `chatListQueryHelpers.js` — `buildChatListFetchParams` **e** `buildCountsQueryParams` setam `whatsapp_instance_id` (≠ "todos").
3. `chatListFilters.js` — **filtragem local** em `computeChatsFiltrados` (inbound de outro número via socket não vaza) +
   `buildChatListUiFilterDeps` + `areChatListUiFilterDepsEqual`.
4. `ChatListAdvancedFiltersPanel.jsx` — `<select>` "Número" (opções via `whatsappInstanceLabel`), só quando `hasMultiple`.
5. `chatList.jsx` — lê `whatsappInstancesStore` (instances + hasMultiple), passa aos params de lista/contadores, às deps
   dos effects de reload/counts, ao `ChatListBody` e ao painel. `ChatListBody.jsx` + `hooks/useChatListFilters.js` repassam ao compute.
6. `chatService.js` — `fetchChats`/`fetchChatCounts` enviam `whatsapp_instance_id`.

Consistência lista↔contadores garantida (mesmo param nos dois; cache key inclui o número). Backward-compatible: com 1 número
`hasMultiple=false` → seletor oculto, filtro "todos" → zero mudança.

---

## 14. Análise avançada + recomendações (2026-09-14)

### Certificado fim-a-fim (não só sintaxe)
- **`has_multiple` conta só instâncias ATIVAS** (`controllers/chat/integrationController.js` — `active.length > 1`).
  O badge/UI por número só acende com 2+ números **ativos** (um canal desativado não dispara a UI). ✓
- **Badge é renderizado de fato** em `frontend/src/chats/ChatListRow.jsx:1514` (`<div className="chat-list-whatsapp-instance">`),
  título "Numero WhatsApp: …". Rótulo = `whatsapp_instance_nome || display_phone`. ✓
- **Disparo já é multi-número:** existe `controllers/disparoInstanciasController.js` (etapa de escolha de instância da
  campanha) e o `disparoSendService` roteia por `item.instancia_id`. Campanhas por número já suportadas. ✓
- **Provisionamento do 2º canal (Etapa 2):** o novo canal recebe `configureWebhooks` próprio (webhook por `channel_id`);
  não vira default (guarda cross-provider em `createWhatsappInstance`); `node --check` OK.

### Correção aplicada nesta análise
- **Teto de canais passou a contar só ATIVAS** (`whapiAtivas`), consistente com `has_multiple`, e a mensagem virou
  "Desative um número antes de adicionar outro" (acionável — antes dizia "remova", mas não há remoção). Era um mismatch
  entre o teto (contava inativas) e o resto do sistema.

### Recomendações (prioridade) — estado 2026-09-14
1. **Filtro por número na lista** — ✅ **COMPLETO** (backend + serviço + UI). Seletor "Número" nos filtros avançados,
   só quando `hasMultiple`; lista e contadores consistentes; filtragem local anti-vazamento de socket. Ver §13.
2. **Gerir números no painel** (`WhapiConnectPanel.jsx`): renomear + desativar — ✅ **FEITO** (aguarda deploy).
   `renomearInstanciaWhapi`/`desativarInstanciaWhapi` + bloco "Gerenciar número" (guarda o número padrão).
3. **Teste do `provisionWhapiInstance`** (caminho `novo:true` + teto 409 + idempotência sem flag). A função não tem
   cobertura e agora cria canais Partner (custo). Média. **Ainda pendente.**
4. **Sync company-level por instância** (§4.3) — hoje cobre só a instância default. Baixa (envio/recebimento não dependem).
5. **Rótulo do badge quando sem nome amigável**: canal auto-nomeado vira "ZapERP empresa X #2" no badge; o campo de nome
   no "adicionar número" mitiga. Opcional: preferir `display_phone` quando o nome for o automático. Baixa.

### Sem achados de regressão
UltraMSG intocado; mudanças 100% aditivas; nenhuma quebra em fluxos de 1 número (caminho legacy-null + `has_multiple=false`).

---

## 10. Histórico

- **2026-09-12** — Documento criado a partir de análise profunda do código (schema, inbound, outbound, disparo,
  socket, painel, frontend). Diagnóstico read-only no banco real confirmou fundação 100% aplicada (§11);
  risco reordenado (backfill vira pré-requisito do 2º número). Nenhuma alteração de runtime — só documentação.
