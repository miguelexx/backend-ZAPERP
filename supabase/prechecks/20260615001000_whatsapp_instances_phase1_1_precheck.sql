-- Precheck Fase 1.1: executar antes da migration de hardening.
-- Qualquer linha retornada precisa ser corrigida antes de avancar.

WITH whatsapp_instances_dups AS (
  SELECT
    'whatsapp_instances' AS source_table,
    provider,
    lower(
      CASE
        WHEN lower(btrim(instance_id)) LIKE 'instance%' THEN substring(btrim(instance_id) FROM 9)
        ELSE btrim(instance_id)
      END
    ) AS normalized_instance_id,
    array_agg(id ORDER BY id) AS row_ids,
    array_agg(company_id ORDER BY company_id) AS company_ids,
    count(*) AS total
  FROM public.whatsapp_instances
  WHERE ativo = true
    AND length(btrim(COALESCE(instance_id, ''))) > 0
  GROUP BY provider, normalized_instance_id
  HAVING count(*) > 1
),
empresa_zapi_dups AS (
  SELECT
    'empresa_zapi' AS source_table,
    'ultramsg' AS provider,
    lower(
      CASE
        WHEN lower(btrim(instance_id)) LIKE 'instance%' THEN substring(btrim(instance_id) FROM 9)
        ELSE btrim(instance_id)
      END
    ) AS normalized_instance_id,
    array_agg(id ORDER BY id) AS row_ids,
    array_agg(company_id ORDER BY company_id) AS company_ids,
    count(*) AS total
  FROM public.empresa_zapi
  WHERE ativo = true
    AND length(btrim(COALESCE(instance_id, ''))) > 0
  GROUP BY normalized_instance_id
  HAVING count(*) > 1
)
SELECT *
FROM whatsapp_instances_dups
UNION ALL
SELECT *
FROM empresa_zapi_dups
ORDER BY source_table, provider, normalized_instance_id;
