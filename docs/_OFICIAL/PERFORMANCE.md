# Performance e estabilidade — ZapERP

Consolida **boas práticas** alinhadas ao código (Node/Express/Socket.IO/Supabase) e às **Cursor rules** (`.cursor/rules/zaperp-core-rules.mdc`, `zaperp-performance`, `socketio-realtime`, `zaperp-ui-premium`).  
O frontend é **React + Vite** (`frontend/package.json`).

---

## 1. Backend — API e Node

| Prática | Motivo |
|---------|--------|
| Usar **`apiLimiter`** / **`webhookLimiter`** onde já aplicados | Protege contra abuso e picos |
| Manter operações pesadas **fora** da thread de request quando possível | `setImmediate`, jobs em `jobs` + `queueManager` |
| **Paginar** listagens de conversas/mensagens | Evita carregar histórico completo na memória |
| **Filtrar sempre por `company_id`** | Reduz dados transferidos e risco de vazamento multi-tenant |
| Evitar **N+1** queries | Agrupar selects ou usar joins/RPC conscientes |
| Preferir colunas explícitas em `.select()` | Evita `SELECT *` (regra do projeto) |

**Gargalos conhecidos (genéricos):**

- Listagens sem limite + ordenação pesada em tabelas grandes.
- Jobs longos sem `checkpoints_sync` / locks adequados (ver migrações `protecao_operacional`).

---

## 2. PostgreSQL / Supabase

| Prática | Detalhe |
|---------|---------|
| Respeitar **`company_id`** em índices compostos | Migrações `20250209000000` e afins |
| Aplicar índices sugeridos em **janela de manutenção** | Ver `../PERFORMANCE-INDICES-SUGERIDOS.sql` — usa `CONCURRENTLY` onde indicado |
| Revisar planos com `EXPLAIN (ANALYZE, BUFFERS)` em staging | Antes de criar índices ad hoc |

**Práticas proibidas / de alto risco:**

- `SELECT *` em código novo.
- Migrações destrutivas em produção sem backup e sem confirmação explícita (regra do projeto).

---

## 3. Socket.IO (servidor)

| Prática | Motivo |
|---------|--------|
| **Não duplicar** `socket.join` sem necessidade | `join_conversa` já verifica `socket.rooms.has(room)` |
| Usar salas já definidas (`empresa_*`, `conversa_*`, …) | Contrato estável com o frontend |
| Evitar broadcasts globais desnecessários | Usar `emitEmpresa` / `emitConversa` com filtros |
| Preservar nomes em **`io.EVENTS`** ao adicionar eventos | Evita quebra de clientes antigos |

**Anti-padrões:**

- Registrar listeners `io.on` dentro de handlers de request (risco de duplicação — não aplicável da mesma forma, mas evitar padrões que multipliquem listeners no servidor).
- Memory leaks por closures segurando `socket` em caches sem limpeza.

---

## 4. Socket.IO / cliente (frontend)

| Prática | Motivo |
|---------|--------|
| Re-subscrever salas após **reconnect** | Sockets perdem joins |
| Debounce de eventos de typing | Reduz tráfego |
| Não ligar **dois** clients Socket ao mesmo tempo no mesmo ecrã sem cleanup | Duplica eventos e carga |

---

## 5. React / Vite (`frontend/package.json`)

Bibliotecas relevantes a performance:

- **`@tanstack/react-virtual`** — listas longas (conversas/mensagens) devem virtualizar quando aplicável no código.
- **`zustand`** — estado global; evitar atualizar stores inteiros em cada tecla.
- **`@dnd-kit`** — drag-and-drop; usar só onde necessário para não pesar render.

| Prática | Motivo |
|---------|--------|
| **Memoização** (`memo`, `useCallback`, `useMemo`) onde medição mostrar ganho | Menos renders em listas |
| Code splitting / lazy routes (quando já existir padrão) | Menor JS inicial |
| Preservar **scroll** e estado de conversa ao navegar | Requisito UX nas rules |

**Anti-padrões UI:**

- Re-renderizar lista completa a cada mensagem sem virtualização.
- Anexar listeners de `window`/`document` sem remover no unmount.

---

## 6. Webhooks UltraMSG

| Prática | Motivo |
|---------|--------|
| Responder rápido com **200** quando o negócio já persistiu ou quando o evento é ignorado por design | UltraMSG pode retentar em falhas |
| Manter **idempotência** no insert de mensagens | Índices únicos + lógica de conflito |
| Não logar segredos | Tokens mascarados no provider |

---

## 7. Uploads e mídia

- `multer` + limites de tamanho; tipos permitidos em `middleware/upload.js`.
- Servir `/uploads` com headers seguros (`X-Content-Type-Options`, download forçado para não-imagens) — ver `app.js`.

---

## 8. Segurança ↔ performance

- **Helmet** e CSP já configurados; alterações devem medir impacto em iframes (`/uploads`, PDF).
- **Rate limit** é parte da defesa em profundidade — não remover por “ganho” marginal sem análise.

---

## 9. Ferramentas Cursor / skills

Para auditorias focadas, usar as skills do repositório:

- **zaperp-performance** — profiling mental, queries, memória.
- **socketio-realtime** — revisão de eventos e reconexão.
- **zaperp-whatsapp** — webhooks, `fromMe`, mídia UltraMSG.
- **security-auditor** — auth, multi-tenant, uploads.

---

## 10. Checklist rápido antes de merge

- [ ] Todas as queries novas com **`company_id`** explícito?  
- [ ] Novos eventos Socket documentados em `io.EVENTS` e no frontend?  
- [ ] Índice para filtros novos?  
- [ ] Nenhum listener duplicado no cliente?  
- [ ] Webhook continua a responder **200** nos casos esperados?

---

## 11. Ficheiros de apoio no repositório

- `backend/docs/PERFORMANCE-INDICES-SUGERIDOS.sql` — sugestões SQL (não aplicadas automaticamente).
- `backend/docs/FEATURE-FLAGS.md` — comportamento por ENV (quando existir).
