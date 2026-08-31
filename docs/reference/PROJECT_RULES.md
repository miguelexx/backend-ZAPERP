# Regras oficiais do projeto — ZapERP

Consolida **obrigações** para humanos e agentes (Cursor).  
**Fonte normativa:** `.cursor/rules/zaperp-core-rules.mdc` e `.cursor/rules/zaperp-docs-context-rule.mdc`. Em caso de conflito, prevalecem esses ficheiros.

---

## 1. Identidade do produto

- **Nome:** ZapERP / repositório `whatsapp-plataforma`.
- **Idioma:** comunicação com a equipa em **português** (quando aplicável).
- **WhatsApp:** provider **UltraMSG** apenas; **não** implementar, migrar ou assumir **Z-API** sem pedido explícito.
- **Documentação:** índice em `backend/docs/README.md`. Pastas `docs/_ANTIGOS/` e `docs/_OFICIAL/` **não existem** neste tree; não procurar. Código sempre prevalece sobre markdown.

---

## 2. Multi-tenant e dados

| Regra | Detalhe |
|-------|---------|
| **Sempre** filtrar por `company_id` em queries de negócio | JWT e socket exigem `company_id`; reforçar na camada de dados |
| **Nunca** expor dados de outra empresa por omissão de filtro | Revisar joins e RPCs |
| **Evitar `SELECT *`** | Colunas explícitas; melhor para índices e segurança |
| **Não** executar SQL destrutivo em produção sem confirmação explícita | Inclui scripts em `supabase/` |
| **`SERVICE_ROLE_KEY` ignora RLS globalmente** | O cliente Supabase usa `SERVICE_ROLE_KEY` — isso bypassa **todo** RLS do banco. Todo isolamento entre empresas é **exclusivamente app-layer**, via filtro `company_id` no código. Não existe proteção de banco compensando uma query sem filtro. |

---

## 3. Segurança e conformidade

**Nunca remover ou enfraquecer:**

- Autenticação e autorização (JWT REST, auth Socket).
- Middlewares de segurança (`helmet`, rate limit, validação de webhook, CORS).
- Validações existentes e isolamento por empresa.
- Tratamento de erros e logs operacionais importantes.

**Variáveis sensíveis:** não commitar `.env` real; não expor secrets em logs ou respostas HTTP.

---

## 4. Alterações de código

| Regra | Detalhe |
|-------|---------|
| **Não** alterar fluxos já funcionais sem pedido explícito | Evita regressões em produção |
| **Não** fazer refactors amplos sem explicar impacto antes | Regra explícita do projeto |
| **Não** duplicar lógica** se já existir service/helper** | Preferir modularização |
| Preservar **compatibilidade** com clientes e dados existentes | Contratos Socket e REST |

---

## 5. WhatsApp / UltraMSG

- Preservar **idempotência** de webhooks e **unicidade** de mensagens (`whatsapp_id`).
- Tratar **`fromMe`** corretamente na normalização e persistência.
- Manter sincronização de **mídia** (imagem, áudio, vídeo, documento, contacto, localização) alinhada ao provider.
- Não documentar nem codar **rotas públicas Z-API** como padrão atual sem validação em `app.js`.

---

## 6. Socket.IO

- **Evitar listeners duplicados** e **memory leaks**.
- Preservar **nomes de eventos** existentes (`io.EVENTS`); novos eventos devem ser adicionados de forma compatível.
- Garantir **reconexão estável** no cliente (re-join de salas após reconnect quando aplicável).

---

## 7. Frontend (React / Vite)

- Layout **responsivo**: desktop, tablet/iPad, mobile.
- Estilo **tipo WhatsApp Web** (requisito de produto).
- **Performance:** evitar re-renderizações desnecessárias; preservar scroll, paginação e estado das conversas.
- Usar padrões já presentes (**Zustand**, **react-virtual**, etc.) em vez de reinventar.

---

## 8. Padrões de organização (backend)

| Camada | Responsabilidade |
|--------|------------------|
| **controllers/** | HTTP, status codes, delegação |
| **services/** | Regras de negócio, integrações, orquestração |
| **repositories/** | Acesso a dados quando o padrão existir |
| **helpers/** | Funções puras / utilitários compartilhados |
| **middleware/** | Cross-cutting: auth, rate limit, webhook, upload |
| **routes/** | Mapeamento método → controller |

---

## 9. Padrões de organização (frontend)

- Componentes e hooks **co-localizados** com o domínio da feature quando já for o padrão do repo.
- Estado global **Zustand** — evitar stores “Deus” sem namespaces.
- Chamadas HTTP **axios** (dependência declarada).

---

## 10. Análise contínua (checklist mental)

Ao rever código, procurar:

- Gargalos de query, N+1, índices ausentes.
- Vazamentos de memória e listeners duplicados.
- Loops desnecessários e re-renders excessivos.
- Erros silenciosos (`catch` vazio).

---

## 11. Ambiente e deploy

- **Não** mexer em produção, chaves, `.env` real ou deploy **sem autorização explícita**.

---

## 12. Uso de MCP e ferramentas

- **Supabase readonly MCP:** usar para validar schema quando disponível; falhas de rede não substituem revisão de migrações.
- **Browser MCP / outros MCPs:** seguir instruções do descritor de ferramentas antes de invocar.

---

## 13. Skills Cursor recomendadas por tema

| Tema | Skill (`.cursor/skills/`) |
|------|---------------------------|
| Backend geral | `backend-auditor` |
| Segurança | `security-auditor` |
| Socket/realtime | `socketio-realtime` |
| Performance | `zaperp-performance` |
| UI WhatsApp-like | `zaperp-ui-premium` |
| UltraMSG / webhooks | `zaperp-whatsapp` |

---

## 14. Subagente UI

- `.cursor/agents/frontend-whatsapp-ui.md` — orientação de alto nível para UI; sempre cruzar com o **código real** do frontend.

---

## 15. Nomenclatura legada (`zapi_*`, `webhookZapiController`)

Ver **[ADR-LEGACY-NAMING.md](./ADR-LEGACY-NAMING.md)** antes de renomear ficheiros, tabelas, colunas ou eventos Socket. O provider oficial continua a ser **UltraMSG**.

---

## 16. Resumo “não fazer”

1. Quebrar multi-tenant.  
2. Remover segurança ou rate limits “por conveniência”.  
3. Assumir Z-API/Meta como arquitetura atual.  
4. Confiar em markdown antigo (planos de monolito, snapshots Jest, pastas `_ANTIGOS`/`_OFICIAL`) sem validar no código.  
5. Introduzir `SELECT *` ou listeners duplicados.  
6. Alterar contratos Socket sem coordenação com o frontend.
