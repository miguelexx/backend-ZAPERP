-- Diagnóstico webhook_logs — empresa 10 (UltraMsg)
-- Rode no SQL Editor do Supabase (ou psql).

-- Instância cadastrada para company 10 (ajuste se mudar no painel)
-- \set inst 'instance171535'

-- ---------------------------------------------------------------------------
-- 1) Últimos webhooks onde company_id = 10 (fluxo normal após mapear instância)
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
WHERE company_id = 10
  AND provider = 'ultramsg'
ORDER BY criado_em DESC
LIMIT 200;

-- ---------------------------------------------------------------------------
-- 2) Resumo por status (últimos 7 dias) — company 10
-- ---------------------------------------------------------------------------
SELECT
  status,
  COUNT(*) AS qtd,
  MAX(criado_em) AS ultimo_em
FROM public.webhook_logs
WHERE company_id = 10
  AND provider = 'ultramsg'
  AND criado_em >= now() - interval '7 days'
GROUP BY status
ORDER BY qtd DESC;

-- ---------------------------------------------------------------------------
-- 3) Falhas / ignorados — company 10 (últimos 7 dias)
-- ---------------------------------------------------------------------------
SELECT
  id,
  criado_em,
  status,
  event_type,
  instance_id,
  response_status,
  error_message,
  response_body
FROM public.webhook_logs
WHERE company_id = 10
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
-- 4) IMPORTANTE: eventos SEM company_id mas com a instância da empresa 10
--    (ex.: token 401 antes de resolver empresa, ou instance_not_mapped)
--    Ajuste o padrão se o instance_id no painel UltraMsg for outro.
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
  AND company_id IS DISTINCT FROM 10
  AND (
    instance_id IN ('instance171535', '171535')
    OR instance_id ILIKE '%171535%'
  )
ORDER BY criado_em DESC
LIMIT 100;
