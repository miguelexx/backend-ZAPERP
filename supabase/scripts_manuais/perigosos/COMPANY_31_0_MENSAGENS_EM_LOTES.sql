-- =============================================================================
-- COMPANY_31_0_MENSAGENS_EM_LOTES.sql     *** APAGA DADOS ***
-- =============================================================================
-- OPCIONAL. So use se `mensagens` da empresa 31 tiver muita linha (acima de
-- ~500 mil, veja o COMPANY_31_1_SIMULAR.sql).
--
-- Motivo: o COMPANY_31_2_APAGAR.sql e uma transacao unica. Apagar alguns
-- milhoes de linhas de uma vez segura lock e incha o WAL. Este arquivo tira o
-- grosso de `mensagens` em lotes, cada lote no seu proprio commit, ANTES de
-- rodar o COMPANY_31_2_APAGAR.sql (que depois leva o resto normalmente).
--
-- COMO USAR: rode o statement abaixo e repita (botao Run de novo) ate ele
-- retornar 0 linhas afetadas. Cada execucao e independente e commita sozinha
-- -- pode parar no meio sem deixar o banco inconsistente, porque mensagem nao
-- tem filha com FK.
--
-- Nao use loop com COMMIT dentro de DO block aqui: o SQL Editor do Supabase
-- roda o buffer dentro de uma transacao e o COMMIT falha.
-- =============================================================================

DELETE FROM public.mensagens
WHERE ctid IN (
  SELECT ctid
  FROM public.mensagens
  WHERE company_id = 31
  LIMIT 20000
);

-- Quanto falta:
-- SELECT count(*) FROM public.mensagens WHERE company_id = 31;
