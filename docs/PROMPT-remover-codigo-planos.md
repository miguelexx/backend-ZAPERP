# Prompt — Remover código de planos (sistema sem billing)

> Contexto: a tabela `planos` e a FK `empresas_plano_id_fkey` foram removidas pela
> migration `20260812160000_drop_planos.sql`. O sistema não é cobrado por planos.
> A coluna `empresas.plano_id` foi mantida (nullable, sem FK) para não quebrar o save
> de config; remova as referências no código e, ao final, dropar a coluna.

Cole como prompt inicial da sessão:

---

Remova o código de planos deste backend (sistema não tem billing). A tabela `planos` já foi dropada. Faça análise atenta e rode os testes.

**Remover em `controllers/configController.js`:**
- O endpoint `GET /config/planos` (`getPlanos`, ~linha 165–173) que faz `.from('planos')`.
- O tratamento de `plano_id` no update de empresa (destructuring ~linha 39 e `if (plano_id !== undefined) update.plano_id = ...` ~linha 60).

**Remover em `routes/configRoutes.js`:**
- A rota `router.get('/planos', ...)`.

**Banco (migration de follow-up, depois que o código não usar mais plano_id):**
- `ALTER TABLE public.empresas DROP COLUMN IF EXISTS plano_id;`

**Testes/limpeza:**
- `grep -rIn "planos\|plano_id" --include=*.js controllers services routes` → não deve sobrar nada ativo.
- `npm test` verde.
- Verificar frontend que chamava `/config/planos` ou exibia seletor de plano.
