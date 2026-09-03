-- ============================================================
-- LIMPEZA DE CLIENTES — cap de 2500 por empresa
-- ============================================================
-- FASE 1 (segura): apaga clientes SEM nenhuma conversa
--   Prioridade: nome=telefone → sem nome → com nome
--
-- FASE 2 (mais agressiva): para empresas que ainda ficaram > 2500
--   apaga os clientes com CONVERSA MAIS ANTIGA até chegar em 2500.
--   As conversas ficam no banco anônimas (sem cliente vinculado).
--
-- SEQUÊNCIA RECOMENDADA:
--   1. Fase 1 DRY-RUN → confira → Fase 1 EXECUTE
--   2. Fase 2 DRY-RUN → confira → Fase 2 EXECUTE
-- ============================================================


-- ════════════════════════════════════════════════════════════
-- FASE 1 — DRY-RUN: clientes SEM conversa
-- ════════════════════════════════════════════════════════════

WITH sem_conversa AS (
  SELECT c.id, c.company_id,
    CASE
      WHEN c.nome IS NOT NULL AND c.nome = c.telefone THEN 1
      WHEN c.nome IS NULL OR trim(c.nome) = ''        THEN 2
      ELSE                                                 3
    END AS prioridade
  FROM clientes c
  WHERE NOT EXISTS (SELECT 1 FROM conversas cv WHERE cv.cliente_id = c.id)
),
total AS (SELECT company_id, COUNT(*) AS total FROM clientes GROUP BY company_id),
excesso AS (SELECT company_id, GREATEST(0, total - 2500) AS excesso FROM total WHERE total > 2500),
candidatos AS (
  SELECT sc.id, sc.company_id, sc.prioridade, ep.excesso,
    ROW_NUMBER() OVER (PARTITION BY sc.company_id ORDER BY sc.prioridade, sc.id) AS rn
  FROM sem_conversa sc JOIN excesso ep ON ep.company_id = sc.company_id
),
deletar AS (SELECT * FROM candidatos WHERE rn <= excesso)
SELECT
  company_id,
  MAX(excesso)                               AS excesso_inicial,
  COUNT(*)                                   AS fase1_deletar,
  MAX(excesso) - COUNT(*)                    AS lacuna_restante_para_fase2,
  COUNT(*) FILTER (WHERE prioridade = 1)     AS nome_igual_fone,
  COUNT(*) FILTER (WHERE prioridade = 2)     AS sem_nome,
  COUNT(*) FILTER (WHERE prioridade = 3)     AS com_nome_sem_conv
FROM deletar GROUP BY company_id ORDER BY company_id;


-- ════════════════════════════════════════════════════════════
-- FASE 1 — EXECUTE (descomente para rodar)
-- ════════════════════════════════════════════════════════════
/*

WITH sem_conversa AS (
  SELECT c.id, c.company_id,
    CASE
      WHEN c.nome IS NOT NULL AND c.nome = c.telefone THEN 1
      WHEN c.nome IS NULL OR trim(c.nome) = ''        THEN 2
      ELSE                                                 3
    END AS prioridade
  FROM clientes c
  WHERE NOT EXISTS (SELECT 1 FROM conversas cv WHERE cv.cliente_id = c.id)
),
total AS (SELECT company_id, COUNT(*) AS total FROM clientes GROUP BY company_id),
excesso AS (SELECT company_id, GREATEST(0, total - 2500) AS excesso FROM total WHERE total > 2500),
candidatos AS (
  SELECT sc.id, sc.company_id, ep.excesso,
    ROW_NUMBER() OVER (PARTITION BY sc.company_id ORDER BY sc.prioridade, sc.id) AS rn
  FROM sem_conversa sc JOIN excesso ep ON ep.company_id = sc.company_id
),
ids AS (SELECT id FROM candidatos WHERE rn <= excesso)
DELETE FROM clientes WHERE id IN (SELECT id FROM ids);

*/


-- ════════════════════════════════════════════════════════════
-- FASE 2 — DRY-RUN: clientes COM conversa mais antiga
-- (empresas com lacuna_restante_para_fase2 > 0 após Fase 1)
-- ════════════════════════════════════════════════════════════

WITH total AS (SELECT company_id, COUNT(*) AS total FROM clientes GROUP BY company_id),
lacuna AS (
  -- Quantos ainda faltam deletar para chegar em 2500
  -- (considera que Fase 1 já rodou; se não rodou ainda, o número pode diferir)
  SELECT company_id, GREATEST(0, total - 2500) AS a_deletar
  FROM total WHERE total > 2500
),
ultima_conv AS (
  SELECT cv.cliente_id, MAX(cv.ultima_atividade) AS ultima_atividade
  FROM conversas cv WHERE cv.cliente_id IS NOT NULL GROUP BY cv.cliente_id
),
com_conv AS (
  SELECT c.id, c.company_id, c.nome, uc.ultima_atividade,
    ROW_NUMBER() OVER (
      PARTITION BY c.company_id
      ORDER BY uc.ultima_atividade ASC NULLS FIRST, c.id ASC
    ) AS rn,
    l.a_deletar
  FROM clientes c
  JOIN ultima_conv uc ON uc.cliente_id = c.id
  JOIN lacuna l ON l.company_id = c.company_id
),
deletar2 AS (SELECT * FROM com_conv WHERE rn <= a_deletar)
SELECT
  company_id,
  COUNT(*)                        AS fase2_deletar,
  MIN(ultima_atividade)::date     AS conv_mais_antiga,
  MAX(ultima_atividade)::date     AS conv_mais_recente_a_apagar
FROM deletar2 GROUP BY company_id ORDER BY company_id;


-- ════════════════════════════════════════════════════════════
-- FASE 2 — EXECUTE (descomente para rodar APÓS a Fase 1)
-- ════════════════════════════════════════════════════════════
-- Usa tabela temporária para calcular os IDs uma só vez e
-- reutilizar nos 3 passos sem recalcular.
-- ════════════════════════════════════════════════════════════
/*

-- Passo 0: calcula os IDs a deletar e guarda na temp
CREATE TEMP TABLE _clientes_fase2 AS
WITH total AS (SELECT company_id, COUNT(*) AS total FROM clientes GROUP BY company_id),
lacuna AS (
  SELECT company_id, GREATEST(0, total - 2500) AS a_deletar
  FROM total WHERE total > 2500
),
ultima_conv AS (
  SELECT cv.cliente_id, MAX(cv.ultima_atividade) AS ultima_atividade
  FROM conversas cv WHERE cv.cliente_id IS NOT NULL GROUP BY cv.cliente_id
),
com_conv AS (
  SELECT c.id, c.company_id,
    ROW_NUMBER() OVER (
      PARTITION BY c.company_id
      ORDER BY uc.ultima_atividade ASC NULLS FIRST, c.id ASC
    ) AS rn,
    l.a_deletar
  FROM clientes c
  JOIN ultima_conv uc ON uc.cliente_id = c.id
  JOIN lacuna l ON l.company_id = c.company_id
)
SELECT id, company_id FROM com_conv WHERE rn <= a_deletar;

-- Confirma quantos serão apagados por empresa:
SELECT company_id, COUNT(*) AS total FROM _clientes_fase2 GROUP BY company_id;

-- Passo 1: remove etiquetas (FK sem ON DELETE — bloquearia o DELETE)
DELETE FROM cliente_tags WHERE cliente_id IN (SELECT id FROM _clientes_fase2);

-- Passo 2: anonimiza avaliações (FK sem ON DELETE — bloquearia o DELETE)
UPDATE avaliacoes_atendimento SET cliente_id = NULL
WHERE cliente_id IN (SELECT id FROM _clientes_fase2);

-- Passo 3: apaga os clientes
-- (conversas ficam no banco mas perdem o vínculo com o cliente)
DELETE FROM clientes WHERE id IN (SELECT id FROM _clientes_fase2);

-- Passo 4: limpa a temp
DROP TABLE _clientes_fase2;

-- Confirma resultado final:
SELECT company_id, COUNT(*) AS total_restante FROM clientes GROUP BY company_id ORDER BY company_id;

*/
