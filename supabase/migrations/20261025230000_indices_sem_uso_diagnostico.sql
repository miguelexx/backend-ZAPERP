-- =====================================================================================
-- Diagnóstico: índices sem uso em `conversas` (e no resto do schema)
--
-- POR QUE (medido em 23/10, auditoria de produção):
--   Nos EXPLAIN de confirmação dos índices novos, o tempo de PLANEJAMENTO passou muito o
--   de execução nas três consultas — e o pior caso foi `conversas`:
--
--     | consulta           | planning | execução | razão |
--     | atendimentos       | 1,440 ms | 0,136 ms |  10×  |
--     | conversa_unreads   | 0,923 ms | 0,115 ms |   8×  |
--     | conversas          | 4,111 ms | 0,278 ms |  15×  |
--
--   A execução está ótima (Index Only Scan em 0,278 ms). O custo está em ESCOLHER o plano:
--   o planejador considera cada índice candidato, e `conversas` tem ~35. São 4,1 ms pagos
--   em TODA consulta à tabela mais quente do sistema — lista, contadores, detalhe, envio.
--
-- ESTE ARQUIVO NÃO ALTERA NADA. São três consultas de leitura. O DROP fica no arquivo
-- seguinte, e só depois de você olhar o resultado destas.
-- =====================================================================================

-- -------------------------------------------------------------------------------------
-- 1. Há quanto tempo as estatísticas estão a contar?
--
-- CRÍTICO ler isto PRIMEIRO: `idx_scan = 0` só significa "sem uso" se o contador vem
-- correndo há tempo suficiente. Se as estatísticas foram zeradas há 2 dias, um índice
-- usado apenas no fechamento do mês aparece como morto — e dropá-lo seria um erro.
-- Regra prática: só confie nestes números com 30+ dias de contagem.
-- -------------------------------------------------------------------------------------
SELECT
  stats_reset,
  now() - stats_reset AS tempo_a_contar,
  CASE
    WHEN stats_reset IS NULL THEN 'NUNCA ZERADO — pode confiar'
    WHEN now() - stats_reset < interval '30 days' THEN 'CONTAGEM CURTA — nao dropar ainda'
    ELSE 'ok, 30+ dias'
  END AS veredito
FROM pg_stat_database
WHERE datname = current_database();

-- -------------------------------------------------------------------------------------
-- 2. Índices de `conversas`, ordenados por desuso
--
-- `idx_scan` = quantas vezes o planejador usou este índice para ler.
-- `indisunique`/`indisprimary` = suporta uma restrição; NUNCA dropar (o banco precisa
-- dele para garantir unicidade, não só para ler).
-- -------------------------------------------------------------------------------------
SELECT
  i.indexrelname                                   AS indice,
  pg_size_pretty(pg_relation_size(i.indexrelid))   AS tamanho,
  i.idx_scan                                       AS leituras,
  idx.indisunique                                  AS e_unique,
  idx.indisprimary                                 AS e_primary,
  CASE
    WHEN idx.indisprimary OR idx.indisunique THEN 'MANTER (suporta restricao)'
    WHEN i.idx_scan = 0 THEN 'CANDIDATO A DROP'
    WHEN i.idx_scan < 50 THEN 'pouco usado — avaliar'
    ELSE 'em uso'
  END AS acao,
  pg_get_indexdef(i.indexrelid)                    AS definicao
FROM pg_stat_user_indexes i
JOIN pg_index idx ON idx.indexrelid = i.indexrelid
WHERE i.relname = 'conversas'
ORDER BY i.idx_scan ASC, pg_relation_size(i.indexrelid) DESC;

-- -------------------------------------------------------------------------------------
-- 3. O mesmo para o schema todo, para ver o quadro geral
-- -------------------------------------------------------------------------------------
SELECT
  i.relname                                        AS tabela,
  count(*)                                         AS total_indices,
  count(*) FILTER (WHERE i.idx_scan = 0
                   AND NOT idx.indisunique
                   AND NOT idx.indisprimary)       AS candidatos_a_drop,
  pg_size_pretty(sum(pg_relation_size(i.indexrelid))) AS espaco_em_indices
FROM pg_stat_user_indexes i
JOIN pg_index idx ON idx.indexrelid = i.indexrelid
GROUP BY i.relname
HAVING count(*) > 5
ORDER BY candidatos_a_drop DESC, total_indices DESC;
