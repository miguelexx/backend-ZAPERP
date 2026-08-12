# Prompt — Sessão de remoção do código do CRM legado

> Contexto: as tabelas `crm_*` foram removidas do banco pela migration
> `supabase/migrations/20260812120000_drop_crm_legacy_module.sql`. O CRM avançado
> agora é um projeto SEPARADO. Falta remover o código Node do CRM legado deste backend.

Cole o texto abaixo como prompt inicial da sessão:

---

Remova o módulo CRM legado deste backend por completo, sem quebrar o resto do sistema. As tabelas `crm_*` já foram dropadas do banco (migration `20260812120000_drop_crm_legacy_module.sql`). Faça uma análise atenta antes de apagar e rode os testes no final.

**Arquivos que são exclusivamente do CRM (apagar por inteiro):**
- `controllers/crmController.js`
- `services/crmService.js`
- `services/crmGoogleService.js`
- `repositories/crmRepository.js`
- `routes/crmRoutes.js`
- `middleware/requireCrmHabilitado.js`
- `helpers/crmEmpresaFlag.js`

**Wiring a remover em `app.js`:**
- linha ~276 `const crmRoutes = require('./routes/crmRoutes')`
- linha ~304 `app.use('/crm', apiLimiter, crmRoutes)`
- linha ~332 `api.use('/crm', crmRoutes)`

**Referências ao flag `crm_habilitado` em arquivos NÃO-CRM (tratar com cuidado, não apagar o arquivo):**
- `controllers/userController.js` — usa `empresaCrmHabilitada` e devolve `crm_habilitado` no payload de `/user/me` e afins. Decidir: remover o campo do retorno OU fixar `crm_habilitado: false`. Garantir que o restante do controller continue funcionando.
- `controllers/configController.js` — aceita/atualiza `crm_habilitado` no update da empresa (linhas ~43, ~64, ~74). Remover o tratamento desse campo.

**Banco (migration nova de follow-up):**
- `ALTER TABLE public.empresas DROP COLUMN IF EXISTS crm_habilitado;`
- NÃO remover `tags.ativo` / `tags.atualizado_em` (a `tags` é compartilhada com conversas).

**Testes/limpeza:**
- Procurar e remover testes do CRM em `tests/` (grep `crm`).
- Rodar `npm test` e garantir verde.
- Conferir que nenhum `require('.../crm...')` órfão sobrou (`grep -rIn "crm" --include=*.js controllers services routes repositories middleware helpers app.js index.js`).
- Verificar o frontend/rotas que chamavam `/crm/*` (fora deste repo) para não deixar chamadas quebradas.

Confirme comigo o comportamento desejado do campo `crm_habilitado` (remover do retorno vs. fixar `false`) antes de finalizar.
