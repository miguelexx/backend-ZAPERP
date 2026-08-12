# Prompt — Sessão de remoção do código do módulo Campanhas

> Contexto: as tabelas `campanhas` e `campanha_envios` foram removidas do banco
> pela migration `20260812140000_drop_campanhas_module.sql`. Falta remover o código.
> IMPORTANTE: NÃO remover opt-in/opt-out — `contato_opt_in`/`contato_opt_out` continuam
> em uso (webhook de recebimento + proteção anti-bloqueio).

Cole o texto abaixo como prompt inicial da sessão:

---

Remova o módulo de Campanhas (disparo em massa) deste backend, sem quebrar o resto. As tabelas `campanhas` e `campanha_envios` já foram dropadas. Faça análise atenta e rode os testes no final.

**Arquivos exclusivos do módulo (apagar por inteiro):**
- `controllers/campanhaController.js`
- `routes/campanhaRoutes.js`
- `services/campanhaService.js`

**Wiring a remover em `app.js`:**
- linha ~269 `const campanhaRoutes = require('./routes/campanhaRoutes')`
- linha ~298 `app.use('/campanhas', apiLimiter, campanhaRoutes)`
- linha ~326 `api.use('/campanhas', campanhaRoutes)`
- linha ~400 (lista de rotas `/campanhas`)

**CUIDADO — NÃO apagar, apenas ajustar/remover a referência a `campanha_envios`:**
- `controllers/clienteController.js` (linhas ~422–428 e ~478–481): o delete em cascata de clientes remove de `campanha_envios`. Como a tabela não existe mais, remover esse trecho (o código já ignora "does not exist", então é seguro tanto remover quanto deixar; preferir remover para limpar).

**NÃO TOCAR (continuam em uso, não são do módulo campanhas):**
- `services/optOutService.js`, `services/protecao/optInService.js` — opt-in/opt-out ativos.
- `contato_opt_in` / `contato_opt_out` no banco.
- `services/campanhaService.js` importa `verificarOptOut` de optOutService — ao apagar campanhaService, o optOutService permanece (é usado pelo webhook).

**Testes/limpeza:**
- Remover testes de campanha em `tests/` (grep `campanha`).
- `npm test` verde.
- Conferir órfãos: `grep -rIn "campanha" --include=*.js controllers services routes app.js` — só devem sobrar (se optar por manter) os warns guardados do clienteController.
- Verificar frontend que chamava `/campanhas/*`.
