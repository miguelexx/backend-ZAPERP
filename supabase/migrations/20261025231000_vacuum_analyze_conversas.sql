-- =====================================================================================
-- VACUUM (ANALYZE) em `conversas`
--
-- POR QUE: no EXPLAIN de confirmação dos índices novos (23/10), `conversas` fez
-- **Index Only Scan** em 0,278 ms — mas com **Heap Fetches = 29**. Index Only Scan só
-- evita ir à heap quando a visibility map está atualizada; cada "heap fetch" é uma ida ao
-- disco que o plano prometia não fazer. O VACUUM atualiza a visibility map e as
-- estatísticas que o planejador usa.
--
-- É a ação mais barata da lista: não altera schema, não trava escrita (VACUUM comum, não
-- FULL) e pode rodar com o sistema no ar.
--
-- NÃO use VACUUM FULL: esse reescreve a tabela inteira e toma ACCESS EXCLUSIVE — o
-- atendimento para enquanto roda.
--
-- COMO RODAR NO SUPABASE SQL EDITOR:
--   VACUUM não pode correr dentro de um bloco de transação, e o editor envelopa o que você
--   cola. Então cole **uma linha por vez**, sem BEGIN/COMMIT, e rode. Se devolver
--   "VACUUM cannot run inside a transaction block" (25001), é isso: rode o comando
--   sozinho, isolado, numa aba limpa.
-- =====================================================================================

VACUUM (ANALYZE) public.conversas;

-- Depois, confirme que os Heap Fetches caíram. Rode o EXPLAIN da consulta da lista
-- (a mesma da auditoria) e compare:
--
--   EXPLAIN (ANALYZE, BUFFERS)
--   SELECT id, ultima_atividade
--   FROM public.conversas
--   WHERE company_id = 1 AND status = 'aberta'
--   ORDER BY ultima_atividade DESC NULLS LAST
--   LIMIT 40;
--
-- Esperado: "Heap Fetches: 0" (ou muito abaixo de 29) e o Planning Time menor que os
-- 4,111 ms medidos. Se o Planning Time NÃO cair, o custo é o número de índices
-- candidatos, e aí o caminho é o diagnóstico do arquivo anterior
-- (20261025230000_indices_sem_uso_diagnostico.sql).

-- As outras duas tabelas quentes da auditoria, pelo mesmo motivo (planning >> execução):
VACUUM (ANALYZE) public.atendimentos;
VACUUM (ANALYZE) public.conversa_unreads;
VACUUM (ANALYZE) public.mensagens;
