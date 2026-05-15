-- Empresa company_id = 1 — ver config do alerta e envios recentes (executar no SQL Editor do Supabase).

SELECT
  company_id,
  updated_at,
  config -> 'admin_atendimento_alerta' AS admin_atendimento_alerta
FROM public.ia_config
WHERE company_id = 1;

SELECT *
FROM public.admin_atendimento_alerta_envios
WHERE company_id = 1
ORDER BY dia_local DESC, criado_em DESC
LIMIT 10;
