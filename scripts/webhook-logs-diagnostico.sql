-- Diagnóstico webhook_logs — UltraMsg (ajuste company_id / instance_id se necessário)
-- Rode no SQL Editor do Supabase ou psql.
--
-- Empresa 6 + instância instance89002 (painel UltraMsg)
--
-- IMPORTANTE sobre a secção 4 abaixo:
-- Essa query PROPOSITALMENTE exclui company_id = 6 — só serve para encontrar
-- o mesmo instance_id a ir parar a OUTRA empresa (conflito). NÃO significa
-- que a empresa 6 está bloqueada. Se a secção 2 mostra muitos "processed"
-- para company_id = 6, o webhook já está a mapear bem para a 6.

-- ---------------------------------------------------------------------------
-- 0) Duplicados em empresa_zapi (causa clássica de mensagens “no sítio errado”)
--    Ver também: scripts/empresa-zapi-instancia-duplicada.sql
-- ---------------------------------------------------------------------------
SELECT instance_id, COUNT(*) AS linhas_ativas, array_agg(company_id ORDER BY company_id) AS companies
FROM public.empresa_zapi
WHERE ativo = true
  AND (
    instance_id IN ('instance89002', '89002')
    OR instance_id ILIKE '%89002%'
  )
GROUP BY instance_id
HAVING COUNT(*) > 1;

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
-- 4) OPCIONAL — só para achar CONFLITO: mesmo instance_id com company_id ≠ 6 ou NULL
--    (ex.: token inválido antes do mapa, ou instância mapeada a outra empresa)
--    Não use esta query para medir se a empresa 6 “recebe” — use a secção 1 ou 2.
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
