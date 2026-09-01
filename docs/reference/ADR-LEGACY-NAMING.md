# ADR — Nomes legados “Z-API” vs realidade UltraMSG

**Status:** aceite  
**Data:** 2026-05-12  
**Contexto:** O provider WhatsApp em produção é **UltraMSG**. Vários identificadores históricos ainda contêm o prefixo **zapi** ou o nome **Z-API**, o que gera confusão para humanos e para ferramentas de IA.

Este ADR **não** autoriza alterações destrutivas; define **verdade arquitetural** e **backlog seguro** para evolução futura.

---

## Decisões

1. **Não renomear** tabelas, colunas, ficheiros de controller nem eventos Socket **sem** plano de compatibilidade (dual-read / dual-emit / re-exports) e janela de versão.
2. **Documentar** explicitamente o mapeamento nome legado → significado atual.
3. **Comentários e READMEs** devem usar a linguagem **WhatsApp / UltraMSG** para o comportamento atual, referindo “legado” só onde o nome persistir por compatibilidade.

---

## Inventário (verdade atual)

| Nome legado | Tipo | Significado hoje | Notas |
|-------------|------|------------------|--------|
| `empresa_zapi` | Tabela PostgreSQL | Credenciais **UltraMSG** por `company_id` (`instance_id`, `instance_token`, …) | Nome da migração original; FKs e scripts dependem deste nome. |
| `zapi_auto_sync_contatos` | Coluna em `empresas` | Preferência “sincronizar contatos ao conectar” (WhatsApp) | Comentário SQL antigo pode citar Z-API; comportamento é agnóstico do provider legado. |
| `zapi_connect_guard` | Tabela | Guard de tentativas/rate de **conexão** WhatsApp | Nome histórico; serviço `whatsappConnectGuardService` já alinha o domínio. |
| `webhookZapiController.js` | Ficheiro + funções (`receberZapi`, `statusZapi`, …) | **Núcleo interno** do pipeline de mensagens/status após normalização UltraMSG | Não expõe rota pública Z-API em `app.js` atual. |
| `req.zapiContext` | Propriedade HTTP | Alias de `req.webhookContext` (`resolveWebhookCompany.js`) | Compatibilidade com código que ainda lê `zapiContext`. |
| `zapi_sync_contatos` | **Evento Socket.IO** (não é tabela) | Emitido ao concluir jobs de sync de contatos/fotos (`queueManager.js`) | Clientes antigos escutam este literal; renome exige **dual-emit** + rollout de frontend. |
| `exports.zapiStatus` | Export | Alias de `whatsappStatus` (`chatController.js`) | Padrão de compat já explícito. |

---

## O que pode ser melhorado agora (baixo risco)

- Comentários em código e SQL orientativos (`RUN_IN_SUPABASE.sql`).
- Comentários JS devem apontar para este ADR (`docs/reference/ADR-LEGACY-NAMING.md`), nunca para a pasta removida `docs/_OFICIAL/`.
- Este ADR e referências cruzadas na doc oficial.

## O que deve permanecer só documentado até decisão explícita

- Qualquer **RENAME** de tabela/coluna.
- Remoção de `req.zapiContext` sem fase de deprecação.
- Substituição única do evento `zapi_sync_contatos`.

## O que exigiria alias / facade / dual-emit (futuro)

| Evolução | Estratégia sugerida |
|----------|---------------------|
| Renomear ficheiro `webhookZapiController.js` | Novo módulo + `module.exports = require('./novo')` temporário; PR dedicado. |
| Renomear evento socket | `io.emit('whatsapp_sync_contatos', …)` **em paralelo** com `zapi_sync_contatos` durante N versões do SPA; depois remover o legado. |
| Coluna `zapi_auto_sync_contatos` | Coluna nova + backfill + leitura dual; só então deprecar (migração não destrutiva). |

## O que **não** deve ser mexido sem projeto próprio

- Fluxo funcional de `receberZapi` / idempotência / `company_id`.
- Autenticação JWT e validação de tenant no Socket.
- Rotas e middlewares de segurança.

---

## TODOs técnicos (backlog — não executar automaticamente)

- [ ] **P2:** Emitir em duplicado `whatsapp_sync_contatos` + `zapi_sync_contatos` (após acordo com frontend e versão mínima).
- [ ] **P3:** Política interna: código novo lê `req.webhookContext`; `zapiContext` só alias.
- [ ] **P4:** VIEW read-only `empresa_whatsapp` → `SELECT * FROM empresa_zapi` (opcional; avaliar impacto em ferramentas).
- [ ] **P5:** Renome físico do controller via re-export (PR isolado + testes de regressão webhook).

---

## Referências

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — fluxo UltraMSG → núcleo interno.
- [`FLOWS.md`](./FLOWS.md) — webhook, socket, jobs.
- [`ULTRAMSG.md`](./ULTRAMSG.md) — contrato do provider.
