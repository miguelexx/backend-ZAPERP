-- =============================================================================
-- Diagnóstico: mídias no banco apontam para disco local (/uploads/) ou remoto (https)?
-- Rodar no Supabase SQL Editor (readonly). Ajuste company_id se quiser filtrar uma empresa.
-- =============================================================================

-- 1) Resumo geral (últimos 90 dias, mensagens com mídia)
SELECT
  CASE
    WHEN url IS NULL OR trim(url) = '' THEN 'sem_url'
    WHEN url ILIKE '/uploads/%' THEN 'local_vps'
    WHEN url ILIKE 'http%' THEN 'remoto_ultramsg_cdn'
    ELSE 'outro'
  END AS tipo_armazenamento,
  tipo,
  count(*) AS qtd
FROM public.mensagens
WHERE criado_em >= now() - interval '90 days'
  AND tipo IN ('imagem', 'sticker', 'video', 'audio', 'voice', 'arquivo')
  -- AND company_id = 1
GROUP BY 1, 2
ORDER BY 1, 3 DESC;

-- 2) Percentual local vs remoto (só mensagens com URL preenchida)
WITH base AS (
  SELECT
    CASE
      WHEN url ILIKE '/uploads/%' THEN 'local_vps'
      WHEN url ILIKE 'http%' THEN 'remoto'
      ELSE 'outro'
    END AS armazenamento
  FROM public.mensagens
  WHERE criado_em >= now() - interval '90 days'
    AND tipo IN ('imagem', 'sticker', 'video', 'audio', 'voice', 'arquivo')
    AND url IS NOT NULL
    AND trim(url) <> ''
    -- AND company_id = 1
)
SELECT
  armazenamento,
  count(*) AS qtd,
  round(100.0 * count(*) / nullif(sum(count(*)) OVER (), 0), 1) AS pct
FROM base
GROUP BY armazenamento
ORDER BY qtd DESC;

-- 3) Ainda remotas (risco de expirar ~24h se a cópia nunca rodou)
SELECT id, company_id, conversa_id, tipo, left(url, 120) AS url_inicio, criado_em
FROM public.mensagens
WHERE url ILIKE 'https%'
  AND tipo IN ('imagem', 'sticker', 'video', 'audio', 'voice', 'arquivo')
  AND criado_em >= now() - interval '30 days'
  -- AND company_id = 1
ORDER BY criado_em DESC
LIMIT 20;

-- 4) Locais recentes (devem existir arquivo na VPS em UPLOADS_DIR)
SELECT id, company_id, tipo, url, criado_em
FROM public.mensagens
WHERE url ILIKE '/uploads/%'
  AND tipo IN ('imagem', 'sticker', 'video', 'audio', 'voice', 'arquivo')
  AND criado_em >= now() - interval '7 days'
  -- AND company_id = 1
ORDER BY criado_em DESC
LIMIT 10;
