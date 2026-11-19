# 42 — Ranking gamificado de atendentes (competição semanal)

> Criado em 2026-11-19. **Não commitado / não deployado. Migration `20261119120000_ranking_gamificado.sql` NÃO aplicada.**

## O que é

Competição semanal por empresa: classifica os atendentes pela quantidade de atendimentos
finalizados, mostra contagem regressiva, encerra sozinho no dia/horário configurado, registra o
resultado consolidado e anuncia o campeão (uma única vez) para a empresa.

## Regra de contagem (NÃO criar outra)

O ranking **não tem contador próprio**. Conta as linhas de `atendimentos` com
`acao = 'encerrou'` por `de_usuario_id` (quem encerrou), dentro de `[inicio, fim)` do ciclo —
**a mesma regra do "Finalizadas hoje" da Supervisão** (`supervisaoService.getResumo` /
`getRelatorioDiarioGestor`).

Consequências (todas herdadas da regra atual, de propósito):

| Situação | Efeito no ranking |
|---|---|
| Transferida e depois encerrada | conta para **quem encerrou** |
| Reaberta e encerrada de novo | **cada** encerramento conta (igual à Supervisão) |
| Finalização automática (ausência/timeout) | não grava `encerrou` → **não conta** para ninguém |
| Clique duplo em encerrar | não duplica (`encerrarChat` devolve `ja_encerrada` antes de registrar) |
| Conversa apagada | apaga as linhas de `atendimentos` → some do ciclo **em andamento**; ciclos encerrados guardam snapshot e não mudam |
| Mensagens enviadas | **nunca** contam |
| **Modo simples** (`atendimento_modo_simples`) | atendentes não precisam encerrar → o ranking pode ficar zerado. Limitação conhecida |

Se um dia a regra de produtividade mudar, mude **na Supervisão e aqui juntas**.

## Arquivos

Backend
- `supabase/migrations/20261119120000_ranking_gamificado.sql` — `ranking_config` (1 linha/empresa) e `ranking_ciclos` (aditiva; índice único parcial = 1 ciclo `em_andamento` por empresa).
- `services/rankingGamificado/rankingRegras.js` — puro: fim do ciclo no fuso, classificação (empates dividem a posição: 1, 1, 3), textos.
- `services/rankingGamificado/rankingGamificadoService.js` — config, ciclos, apuração, cache 15 s (coalescing por empresa+ciclo).
- `services/rankingGamificado/rankingGamificadoScheduler.js` — tick de 30 s (`RANKING_SCHEDULER_INTERVAL_SECONDS`), registrado em `index.js`.
- `controllers/rankingController.js`, `routes/rankingRoutes.js` — montado **só** em `/api/ranking` (`app.js`).
- Testes: `tests/rankingGamificado.test.js` (banco falso em memória), `tests/rankingRoutes.test.js`.

Frontend
- `src/pages/Ranking.jsx` (rota `/ranking`, todos os perfis), `src/configuracoes/sections/RankingSection.jsx` (aba "Ranking", só admin).
- `src/ranking/RankingGlobalBridge.jsx` (montado no `MainLayout`), `CampeaoCelebracao.jsx` (lazy), `rankingStore.js`, `rankingUtils.js`, `ranking.css`.
- `src/api/rankingService.js`. Testes: `scripts/test-ranking-gamificado.mjs` (na `test:node`), `e2e/ranking-local-mock.spec.js`.

## Rotas

| Método | Rota | Quem | O quê |
|---|---|---|---|
| GET | `/api/ranking/atual[?resumo=1]` | qualquer autenticado | ranking ao vivo da própria empresa; `resumo=1` sem contagem (usado no boot) |
| GET | `/api/ranking/config` | `adminOnly` | config + ciclo atual + fuso |
| PUT | `/api/ranking/config` | `adminOnly` | `{ ativo, dia_semana 0–6, horario 'HH:MM' }` |
| GET | `/api/ranking/historico` | `adminOnly` | encerrados com classificação final |

`company_id` sempre do JWT. Sem migration: GET responde `ativo:false, indisponivel:true`; PUT 503; scheduler só avisa 1×.

## Ciclo de vida

- **Ativar** → nasce um ciclo `em_andamento` com `inicio = agora` e `fim` = próxima ocorrência de (dia, horário) no fuso da empresa (`ia_config.config.chatbot_triage.timezone`) **a pelo menos 24 h** (ativar sexta 17h não cria semana de 1 h).
- A regra (dia/horário/fuso) fica **congelada no ciclo**. Mudar a config vale para o **próximo** ciclo (a tela avisa).
- **Encerrar** (scheduler ou o primeiro `GET /atual` após o fim): apura `[inicio, fim)` exato, grava snapshot (`classificacao`, `vencedores`, `total_vencedor`) com `UPDATE … WHERE status='em_andamento'`. Só quem casa esse UPDATE emite `ranking:vencedor` → **nunca anuncia duas vezes** (reinício, 2 processos, scheduler + request).
- Próximo ciclo nasce com `inicio = fim anterior` (sem buraco/sobreposição). Queda entre os dois passos: retoma do fim anterior se foi há < 7 dias.
- **Desativar** → ciclo corrente vira `cancelado` (sem vencedor, nada apagado). Religar começa do zero.
- **Empate no 1º lugar** → todos em `vencedores`. Semana sem atendimentos → sem vencedor.

## Realtime

- `ranking:vencedor` `{ ciclo }` e `ranking:config_atualizada` `{ ativo }` → sala `empresa_{id}`.
- A página recarrega (debounce 2,5 s) no `conversa_encerrada` já existente — que só chega a quem enxerga a conversa — e por poll de 30 s com a aba visível. O cache de 15 s no backend coalesce tudo.
- Celebração: uma vez por pessoa (`localStorage` `zaperp_ranking_celebrado:{company}:{user}`), inclusive para quem estava offline (resumo traz `ultimo_resultado`; janela de 3 dias).

## Deploy

1. Aplicar a migration no SQL Editor do Supabase (antes do código).
2. Deploy backend + frontend. Nada liga sozinho: o admin ativa em Configurações → Ranking.
