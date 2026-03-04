-- ============================================================
-- AUDITORIA: Contatos sem nome ou foto
-- Substituir 1 pelo company_id desejado antes de executar
-- ============================================================

-- 1) Clientes sem nome (ou nome só numérico) — company_id específico
SELECT 
  id,
  telefone,
  nome,
  foto_perfil IS NOT NULL AS tem_foto,
  company_id
FROM clientes
WHERE company_id = 1  -- substituir pelo company_id real
  AND (
    nome IS NULL 
    OR TRIM(nome) = '' 
    OR nome ~ '^\d+$'  -- só dígitos
  )
ORDER BY id DESC
LIMIT 50;

-- 2) Clientes sem foto de perfil
SELECT 
  id,
  telefone,
  nome,
  company_id
FROM clientes
WHERE company_id = 1  -- substituir pelo company_id real
  AND (foto_perfil IS NULL OR TRIM(foto_perfil) = '')
ORDER BY id DESC
LIMIT 100;

-- 3) Conversas (cliente individual) sem cache de nome/foto
-- Útil para LID ou quando cliente ainda não foi criado
SELECT 
  c.id AS conversa_id,
  c.telefone,
  c.cliente_id,
  c.nome_contato_cache,
  c.foto_perfil_contato_cache,
  cl.nome AS cliente_nome,
  cl.foto_perfil AS cliente_foto
FROM conversas c
LEFT JOIN clientes cl ON cl.id = c.cliente_id AND cl.company_id = c.company_id
WHERE c.company_id = 1  -- substituir pelo company_id real
  AND c.tipo IS DISTINCT FROM 'grupo'
  AND c.status_atendimento IN ('aberta', 'em_atendimento')
  AND (
    (c.nome_contato_cache IS NULL OR TRIM(c.nome_contato_cache) = '')
    AND (cl.nome IS NULL OR TRIM(cl.nome) = '' OR cl.nome ~ '^\d+$')
  )
ORDER BY c.ultima_atividade DESC NULLS LAST
LIMIT 50;

-- 4) Contagem agregada (métricas)
SELECT 
  COUNT(*) AS total_clientes,
  COUNT(*) FILTER (WHERE nome IS NOT NULL AND TRIM(nome) != '' AND nome !~ '^\d+$') AS com_nome_real,
  COUNT(*) FILTER (WHERE foto_perfil IS NOT NULL AND TRIM(foto_perfil) != '') AS com_foto
FROM clientes
WHERE company_id = 1  -- substituir pelo company_id real;
