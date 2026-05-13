-- Diagnóstico webhook_logs — UltraMsg (ajuste company_id / instance_id se necessário)
-- Rode no SQL Editor do Supabase ou psql.

-- Empresa 6 + instância instance89002 (painel UltraMsg)

-- ---------------------------------------------------------------------------
-- 1) Últimos webhooks mapeados para company_id = 6
-- ---------------------------------------------------------------------------
SELECT
  id,
  criado_em,
  status,
  event_type,
  instance_id,
  company_id,
  response_status,
  error_message,
  processing_ms,
  ip,
  LEFT(COALESCE(user_agent, ''), 80) AS user_agent_preview
FROM public.webhook_logs
WHERE company_id = 6
  AND provider = 'ultramsg'
ORDER BY criado_em DESC
LIMIT 200;

-- ---------------------------------------------------------------------------
-- 2) Resumo por status (últimos 7 dias) — company 6
-- ---------------------------------------------------------------------------
SELECT
  status,
  COUNT(*) AS qtd,
  MAX(criado_em) AS ultimo_em
FROM public.webhook_logs
WHERE company_id = 6
  AND provider = 'ultramsg'
  AND criado_em >= now() - interval '7 days'
GROUP BY status
ORDER BY qtd DESC;

-- ---------------------------------------------------------------------------
-- 3) Falhas / ignorados (últimos 7 dias) — company 6
-- ---------------------------------------------------------------------------
SELECT
  id,
  criado_em,
  status,
  event_type,
  instance_id,
  company_id,
  response_status,
  error_message,
  response_body
FROM public.webhook_logs
WHERE company_id = 6
  AND provider = 'ultramsg'
  AND criado_em >= now() - interval '7 days'
  AND status IN (
    'rejected_token',
    'ignored_not_mapped',
    'ignored_missing_instance',
    'error'
  )
ORDER BY criado_em DESC
LIMIT 100;

-- ---------------------------------------------------------------------------
-- 4) Eventos com instance89002 mas company_id diferente de 6 ou NULL
--    (token 401, instance não mapeada, ou duplicidade de instance_id)
-- ---------------------------------------------------------------------------
SELECT
  id,
  criado_em,
  status,
  event_type,
  instance_id,
  company_id,
  response_status,
  error_message
FROM public.webhook_logs
WHERE provider = 'ultramsg'
  AND (
    instance_id IN ('instance89002', '89002')
    OR instance_id ILIKE '%89002%'
  )
  AND (company_id IS DISTINCT FROM 6 OR company_id IS NULL)
ORDER BY criado_em DESC
LIMIT 100;
