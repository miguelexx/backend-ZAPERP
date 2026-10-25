-- =====================================================================================
-- Listar TODAS as rotinas chamadas `webhook_logs_cleanup` — antes de dropar mais nada
--
-- O QUE ACONTECEU: o `DROP PROCEDURE ... (integer, integer)` que eu escrevi não removeu a
-- rotina antiga — logo a assinatura real dela é diferente da que assumi. Como a FUNCTION
-- nova foi criada, ficaram duas candidatas para a chamada `(30, 20000)`, e o Postgres
-- recusou escolher:
--
--   ERROR 42725: function public.webhook_logs_cleanup(integer, integer) is not unique
--
-- Eu já errei duas vezes a assinatura desta rotina (primeiro mandei SELECT numa procedure,
-- depois dropei uma assinatura que não existia). Esta consulta **não altera nada**: ela
-- lista o que de facto está no banco e **gera o comando DROP exato** para cada uma, com a
-- assinatura que o próprio Postgres reporta. Daí não há mais o que adivinhar.
-- =====================================================================================

SELECT
  p.oid,
  CASE p.prokind
    WHEN 'f' THEN 'FUNCTION'
    WHEN 'p' THEN 'PROCEDURE'
    WHEN 'a' THEN 'AGGREGATE'
    WHEN 'w' THEN 'WINDOW'
    ELSE p.prokind::text
  END                                              AS tipo,
  pg_get_function_identity_arguments(p.oid)        AS argumentos,
  pg_get_function_result(p.oid)                    AS retorno,
  obj_description(p.oid, 'pg_proc')                AS comentario,
  -- o comando pronto, com a assinatura que o proprio Postgres reporta
  format(
    'DROP %s public.%I(%s);',
    CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END,
    p.proname,
    pg_get_function_identity_arguments(p.oid)
  )                                                AS comando_para_remover
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.proname = 'webhook_logs_cleanup'
  AND n.nspname = 'public'
ORDER BY p.prokind, p.oid;

-- =====================================================================================
-- COMO USAR O RESULTADO
--
-- Devem aparecer 2 linhas: a PROCEDURE antiga e a FUNCTION que acabei de criar.
--
--   1. Copie o `comando_para_remover` **da linha cujo tipo é PROCEDURE** e rode só esse.
--   2. Confirme que sobrou uma só, rodando esta consulta outra vez.
--   3. Aí sim: SELECT public.webhook_logs_cleanup(30, 20000);  -- repetir ate dar 0
--
-- Se aparecerem DUAS FUNCTIONs (e nenhuma procedure), são sobrecargas com tipos
-- diferentes: remova a que NÃO devolve `bigint` — a boa é a que tem o comentário
-- "Apaga UM lote de webhook_logs...".
--
-- Em caso de dúvida sobre qual remover, me mande esta saída antes de dropar: a coluna
-- `retorno` e a `comentario` identificam a correta sem ambiguidade.
-- =====================================================================================
