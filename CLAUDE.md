# ZapERP Backend — handoff automático

> Este arquivo é lido pelo Claude Code antes de cada sessão.

## Onde
`backend/` — repo Git aninhado, branch `master`.  
Stack: Node.js/Express · Supabase SERVICE_ROLE (bypassa RLS) · UltraMSG (único provider WhatsApp) · Socket.IO · PM2 fork 1 instância.

## Protocolo obrigatório (toda sessão, nesta ordem)

**1. Ler antes de qualquer código:**
- [`docs/AI_HANDOFF.md`](docs/AI_HANDOFF.md) — contexto completo: stack, módulos, fluxos, regras, riscos
- [`docs/ai-handoff/17-CHECKLIST-PARA-PROXIMA-IA.md`](docs/ai-handoff/17-CHECKLIST-PARA-PROXIMA-IA.md) — checklist de análise antes de alterar qualquer coisa
- [`docs/ai-handoff/18-ANTI-PADROES-E-ARMADILHAS.md`](docs/ai-handoff/18-ANTI-PADROES-E-ARMADILHAS.md) — 15 armadilhas específicas desta codebase (leitura rápida, evita erros críticos)

**2. Tarefa específica?** Consulte [`docs/README.md`](docs/README.md) para saber qual doc de `docs/ai-handoff/` ler.

**3. Antes de escrever qualquer código, declare:**
- Arquivos e módulos que serão alterados
- Riscos de regressão identificados
- Testes existentes relevantes
- Precisa de migration? De atualizar evento Socket.IO?

**4. Ao terminar, antes de encerrar:**
- Se encontrou algo relevante não documentado → adicione ao doc correspondente em `docs/ai-handoff/`
- Relate: o que mudou · como testar · se precisa de migration · risco residual

## Hardstops — os mais fáceis de esquecer

- `company_id` → SEMPRE de `req.user.company_id`; **nunca** de body/query
- `SERVICE_ROLE_KEY` bypassa **todo** RLS — toda query precisa filtrar `company_id` explicitamente
- **Não commitar / não pushar / não executar migrations** sem autorização explícita do Miguel
- `git status` antes de qualquer edição — nunca descartar trabalho existente
- `webhookZapiController.js` é o handler **ATIVO** de inbound/ACK — nome é legado, não é Z-API
- `PROTECAO_DESATIVADA=true` · `DISPARO_WORKER_ENABLED` default **true** (loop embutido na API) · `DISPARO_LIVE_ENABLED=false` por padrão
- **Migrations antes do deploy** — nunca inverter a ordem; código novo + migration não aplicada = crash em produção

## Vulnerabilidades ativas (não ampliar)

- `middleware/logger.js` loga `req.originalUrl`; `/media/proxy` aceita JWT em query string → **token vai para logs**. Não criar novos endpoints com auth por query param.
- `disparoSaudeController.js` consulta `disparo_worker_heartbeat` **sem filtro `company_id`** → expõe metadados operacionais cross-tenant. Não expandir sem adicionar isolamento.

## Não existe mais (não procure)

`validators/crmValidators.js` · `controllers/campanhaController.js` · `controllers/webhookController.js` (shim 410, não montado) · variáveis `META_*` / `WHATSAPP_TOKEN` no `.env.example`
