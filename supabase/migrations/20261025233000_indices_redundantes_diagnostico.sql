-- =====================================================================================
-- Diagnóstico: índices REDUNDANTES (não apenas "sem uso")
--
-- POR QUE ESTE ARQUIVO EXISTE, e por que o anterior não bastava:
--
--   A saída do quadro geral (25/10) mostrou:
--     | tabela     | total_indices | candidatos_a_drop | espaco  |
--     | mensagens  |      39       |         8         | 1067 MB |
--     | conversas  |      56       |         3         |  123 MB |
--     | clientes   |      20       |         5         |   72 MB |
--
--   `conversas` tem **56 índices** — mais que o dobro do que eu tinha estimado (~35). Mas
--   só **3** aparecem como sem uso. Ou seja: dropar os não-usados NÃO resolve o tempo de
--   planejamento de 4,111 ms, porque o custo vem de o planejador avaliar os 56, e 53 deles
--   têm `idx_scan > 0`.
--
--   E aqui está a parte contraintuitiva: `idx_scan > 0` **não** significa que o índice é
--   necessário. Um índice em `(company_id)` é redundante quando existe outro em
--   `(company_id, status)` — o segundo serve as duas consultas. Mas o planejador às vezes
--   escolhe o menor, então ele acumula leituras e parece vivo. Ele continua custando
--   planejamento em toda consulta, espaço em disco e escrita em todo INSERT/UPDATE.
--
--   Logo o alvo certo não é "sem uso", é **redundante por prefixo**.
--
-- ESTE ARQUIVO NÃO ALTERA NADA. Tudo é leitura.
-- =====================================================================================

-- -------------------------------------------------------------------------------------
-- 1. Índices redundantes por prefixo
--
-- Lê-se: "`indice_redundante` cobre as mesmas colunas, na mesma ordem, que o começo de
-- `indice_que_cobre` — logo o segundo serve no lugar do primeiro".
--
-- Exclusões deliberadas:
--   - UNIQUE e PRIMARY: existem para garantir restrição, não só para ler. Nunca dropar.
--   - índices por expressão (`lower(x)`, trigram): `indkey` guarda 0 para a coluna, então
--     a comparação de prefixo não vale. Saem da lista para não dar conselho errado; a
--     consulta 2 lista-os à parte.
--   - predicados diferentes: um índice parcial (`WHERE status = 'aberta'`) não é coberto
--     por um total com as mesmas colunas no que o planejador precisa saber de custo.
-- -------------------------------------------------------------------------------------
WITH idx AS (
  SELECT
    i.indexrelid,
    c.relname                                        AS tabela,
    ic.relname                                       AS indice,
    i.indisunique,
    i.indisprimary,
    am.amname                                        AS metodo,
    coalesce(pg_get_expr(i.indpred, i.indrelid), '') AS predicado,
    0 = ANY (i.indkey::int2[])                       AS tem_expressao,
    (
      SELECT array_agg(a.attname::text ORDER BY k.ord)
      FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
    )                                                AS colunas,
    pg_relation_size(i.indexrelid)                   AS bytes,
    s.idx_scan
  FROM pg_index i
  JOIN pg_class ic ON ic.oid = i.indexrelid
  JOIN pg_class c  ON c.oid  = i.indrelid
  JOIN pg_am am    ON am.oid = ic.relam
  JOIN pg_stat_user_indexes s ON s.indexrelid = i.indexrelid
  WHERE c.relnamespace = 'public'::regnamespace
    AND i.indisvalid
)
SELECT
  a.tabela,
  a.indice                                  AS indice_redundante,
  pg_size_pretty(a.bytes)                   AS tamanho,
  a.idx_scan                                AS leituras,
  array_to_string(a.colunas, ', ')          AS colunas_dele,
  b.indice                                  AS indice_que_cobre,
  array_to_string(b.colunas, ', ')          AS colunas_do_que_cobre,
  format('DROP INDEX IF EXISTS public.%I;', a.indice) AS comando_sugerido
FROM idx a
JOIN idx b
  ON  b.tabela       = a.tabela
  AND b.indexrelid  <> a.indexrelid
  AND b.metodo       = a.metodo
  AND b.predicado    = a.predicado
  AND NOT b.tem_expressao
  AND array_length(b.colunas, 1) > array_length(a.colunas, 1)
  AND b.colunas[1:array_length(a.colunas, 1)] = a.colunas
WHERE NOT a.indisunique
  AND NOT a.indisprimary
  AND NOT a.tem_expressao
  AND a.colunas IS NOT NULL
ORDER BY a.bytes DESC, a.tabela, a.indice;

-- -------------------------------------------------------------------------------------
-- 2. Índices por expressão (ficam de FORA da análise acima)
--
-- Estão aqui para você ver que existem e que não foram avaliados — não para dropar.
-- Tipicamente são os de busca (trigram/unaccent) e são exatamente os que fazem a busca
-- por nome/telefone funcionar.
-- -------------------------------------------------------------------------------------
SELECT
  c.relname                                      AS tabela,
  ic.relname                                     AS indice,
  am.amname                                      AS metodo,
  pg_size_pretty(pg_relation_size(i.indexrelid)) AS tamanho,
  s.idx_scan                                     AS leituras,
  pg_get_indexdef(i.indexrelid)                  AS definicao
FROM pg_index i
JOIN pg_class ic ON ic.oid = i.indexrelid
JOIN pg_class c  ON c.oid  = i.indrelid
JOIN pg_am am    ON am.oid = ic.relam
JOIN pg_stat_user_indexes s ON s.indexrelid = i.indexrelid
WHERE c.relnamespace = 'public'::regnamespace
  AND 0 = ANY (i.indkey::int2[])
ORDER BY pg_relation_size(i.indexrelid) DESC;

-- -------------------------------------------------------------------------------------
-- 3. Peso da escrita: quanto cada tabela paga em índices por linha
--
-- Todo INSERT/UPDATE mantém TODOS os índices da tabela. Em `mensagens` (39 índices,
-- 1067 MB) isso é pago em cada mensagem recebida ou enviada — é custo de regime, não só
-- de leitura.
-- -------------------------------------------------------------------------------------
SELECT
  c.relname                                               AS tabela,
  count(*)                                                AS indices,
  pg_size_pretty(pg_table_size(c.oid))                    AS dados,
  pg_size_pretty(sum(pg_relation_size(i.indexrelid)))     AS indices_tamanho,
  round(
    sum(pg_relation_size(i.indexrelid))::numeric
    / greatest(pg_table_size(c.oid), 1), 2
  )                                                       AS razao_indice_sobre_dados
FROM pg_index i
JOIN pg_class c ON c.oid = i.indrelid
WHERE c.relnamespace = 'public'::regnamespace
GROUP BY c.oid, c.relname
HAVING count(*) >= 6
ORDER BY sum(pg_relation_size(i.indexrelid)) DESC;
