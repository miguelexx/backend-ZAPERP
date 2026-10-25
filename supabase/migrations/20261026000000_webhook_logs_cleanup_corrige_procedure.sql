-- =====================================================================================
-- Corrige `webhook_logs_cleanup`: o banco tem a PROCEDURE antiga, não a FUNCTION
--
-- O QUE ACONTECEU: a primeira versão desta rotina era uma PROCEDURE com `COMMIT` por
-- lote. Ela foi aplicada no banco. Depois, a migration 20261023181000 foi reescrita como
-- FUNCTION — justamente porque o SQL Editor do Supabase envolve o que você cola numa
-- transação, e aí o `COMMIT` de dentro da procedure é recusado (erro 25001). Mas essa
-- reescrita nunca chegou ao banco: o que está lá continua a PROCEDURE.
--
-- Por isso `SELECT public.webhook_logs_cleanup(30, 20000);` devolveu
--   ERROR 42809: public.webhook_logs_cleanup(integer, integer) is a procedure
--
-- E `CALL` também não resolveria: a procedure antiga dá COMMIT no meio, que o editor
-- recusa. A saída é substituir pela FUNCTION.
--
-- `CREATE OR REPLACE FUNCTION` NÃO substitui uma procedure de mesma assinatura (o
-- Postgres recusa trocar o tipo da rotina), então o DROP vem primeiro.
--
-- Pode colar este arquivo inteiro de uma vez no SQL Editor: não há COMMIT aqui dentro.
-- =====================================================================================

-- ASSINATURA REAL, confirmada no banco em 26/10 via pg_get_function_identity_arguments:
-- a procedure antiga tem TRÊS argumentos (`max_lotes`, com DEFAULT — era o loop com
-- COMMIT por lote). É por isso que ela respondia a uma chamada de dois argumentos e
-- disputava com a função nova, e é por isso que o meu primeiro DROP, escrito para dois
-- argumentos, não removeu nada.
--
-- Lição: nunca escrever DROP de rotina por assinatura suposta. Liste primeiro
-- (20261026001000_webhook_logs_cleanup_listar_rotinas.sql), que o próprio Postgres gera o
-- comando exato.
DROP PROCEDURE IF EXISTS public.webhook_logs_cleanup(IN dias integer, IN tamanho_lote integer, IN max_lotes integer);

CREATE OR REPLACE FUNCTION public.webhook_logs_cleanup(
  dias          integer DEFAULT 30,
  tamanho_lote  integer DEFAULT 20000
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  corte     timestamptz := now() - make_interval(days => GREATEST(dias, 1));
  apagadas  bigint;
BEGIN
  WITH alvo AS (
    SELECT id
      FROM public.webhook_logs
     WHERE criado_em < corte
     ORDER BY criado_em
     LIMIT GREATEST(tamanho_lote, 1)
     FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.webhook_logs w
   USING alvo
   WHERE w.id = alvo.id;

  GET DIAGNOSTICS apagadas = ROW_COUNT;
  RETURN apagadas;
END;
$$;

COMMENT ON FUNCTION public.webhook_logs_cleanup(integer, integer) IS
  'Apaga UM lote de webhook_logs mais antigos que N dias e devolve quantas linhas apagou. Chamar repetidamente ate devolver 0. Ver migration 20261023181000.';

-- =====================================================================================
-- Depois de aplicar o acima, rode isto repetidamente até devolver 0:
--
--   SELECT public.webhook_logs_cleanup(30, 20000);
--
-- Para conferir o progresso entre chamadas:
--
--   SELECT count(*) AS total,
--          count(*) FILTER (WHERE criado_em < now() - interval '30 days') AS a_apagar
--     FROM public.webhook_logs;
-- =====================================================================================
