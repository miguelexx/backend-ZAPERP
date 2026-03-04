-- ============================================================
-- AUDITORIA: Duplicados em clientes, conversas e mensagens
-- Substituir 1 pelo company_id desejado antes de executar
-- ============================================================

-- 1) Clientes duplicados por (company_id, telefone canônico)
-- Normaliza telefone para dígitos (últimos 11) e agrupa
SELECT 
  company_id,
  regexp_replace(telefone, '\D', '', 'g') AS telefone_digits,
  COUNT(*) AS total,
  array_agg(id ORDER BY id) AS cliente_ids
FROM clientes
WHERE company_id = 1  -- substituir pelo company_id real
GROUP BY company_id, regexp_replace(telefone, '\D', '', 'g')
HAVING COUNT(*) > 1;

-- 2) Conversas duplicadas (mesmo company_id + telefone, status aberta/em_atendimento)
SELECT 
  c.company_id,
  c.telefone,
  c.status_atendimento,
  COUNT(*) AS total,
  array_agg(c.id ORDER BY c.id) AS conversa_ids
FROM conversas c
WHERE c.company_id = 1  -- substituir pelo company_id real
  AND c.status_atendimento IN ('aberta', 'em_atendimento')
GROUP BY c.company_id, c.telefone, c.status_atendimento
HAVING COUNT(*) > 1;

-- 3) Mensagens duplicadas por (company_id, whatsapp_id)
-- NÃO deve retornar linhas se o índice único estiver ativo
SELECT 
  company_id,
  whatsapp_id,
  COUNT(*) AS total,
  array_agg(id ORDER BY id) AS mensagem_ids
FROM mensagens
WHERE company_id = 1  -- substituir pelo company_id real
  AND whatsapp_id IS NOT NULL
  AND whatsapp_id != ''
GROUP BY company_id, whatsapp_id
HAVING COUNT(*) > 1;

-- 4) Resumo por empresa (sem filtro company_id — visão global)
SELECT 
  'clientes' AS tabela,
  COUNT(*) AS duplicatas
FROM (
  SELECT company_id, regexp_replace(telefone, '\D', '', 'g') AS k
  FROM clientes
  GROUP BY company_id, k
  HAVING COUNT(*) > 1
) t
UNION ALL
SELECT 
  'conversas',
  COUNT(*)
FROM (
  SELECT company_id, telefone, status_atendimento
  FROM conversas
  WHERE status_atendimento IN ('aberta', 'em_atendimento')
  GROUP BY company_id, telefone, status_atendimento
  HAVING COUNT(*) > 1
) t
UNION ALL
SELECT 
  'mensagens',
  COUNT(*)
FROM (
  SELECT company_id, whatsapp_id
  FROM mensagens
  WHERE whatsapp_id IS NOT NULL
  GROUP BY company_id, whatsapp_id
  HAVING COUNT(*) > 1
) t;
