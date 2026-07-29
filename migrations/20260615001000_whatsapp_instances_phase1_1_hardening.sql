-- Fase 1.1 hardening multi-instancia WhatsApp/UltraMsg.
-- Aditiva e segura: nao remove empresa_zapi nem altera fluxos operacionais.

DO $$
DECLARE
  dup record;
BEGIN
  SELECT
    provider,
    normalized_instance_id,
    array_agg(company_id ORDER BY company_id) AS company_ids,
    count(*) AS total
  INTO dup
  FROM (
    SELECT
      provider,
      company_id,
      lower(
        CASE
          WHEN lower(btrim(instance_id)) LIKE 'instance%' THEN substring(btrim(instance_id) FROM 9)
          ELSE btrim(instance_id)
        END
      ) AS normalized_instance_id
    FROM public.whatsapp_instances
    WHERE ativo = true
      AND length(btrim(COALESCE(instance_id, ''))) > 0
  ) wi
  GROUP BY provider, normalized_instance_id
  HAVING count(*) > 1
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'Duplicidade ativa em whatsapp_instances para provider %, instance_id normalizado %, empresas %. Corrija antes de aplicar a Fase 1.1.',
      dup.provider,
      dup.normalized_instance_id,
      dup.company_ids
      USING ERRCODE = '23505';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_instances_provider_instance_active
  ON public.whatsapp_instances (
    provider,
    lower(
      CASE
        WHEN lower(btrim(instance_id)) LIKE 'instance%' THEN substring(btrim(instance_id) FROM 9)
        ELSE btrim(instance_id)
      END
    )
  )
  WHERE ativo = true;

COMMENT ON INDEX public.uq_whatsapp_instances_provider_instance_active
  IS 'Impede que a mesma instancia UltraMsg ativa pertença a mais de uma empresa, normalizando prefixo instance.';

CREATE OR REPLACE FUNCTION public.set_default_whatsapp_instance(
  p_company_id integer,
  p_whatsapp_instance_id bigint
)
RETURNS public.whatsapp_instances
LANGUAGE plpgsql
AS $$
DECLARE
  v_provider text;
  v_instance public.whatsapp_instances;
BEGIN
  IF p_company_id IS NULL OR p_whatsapp_instance_id IS NULL THEN
    RAISE EXCEPTION 'company_id e whatsapp_instance_id sao obrigatorios'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
  INTO v_instance
  FROM public.whatsapp_instances
  WHERE id = p_whatsapp_instance_id
    AND company_id = p_company_id
    AND ativo = true
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Instancia WhatsApp ativa nao encontrada para esta empresa'
      USING ERRCODE = 'P0002';
  END IF;

  v_provider := v_instance.provider;

  PERFORM 1
  FROM public.whatsapp_instances
  WHERE company_id = p_company_id
    AND provider = v_provider
  FOR UPDATE;

  UPDATE public.whatsapp_instances
  SET is_default = false
  WHERE company_id = p_company_id
    AND provider = v_provider
    AND id <> p_whatsapp_instance_id
    AND is_default = true;

  UPDATE public.whatsapp_instances
  SET is_default = true
  WHERE id = p_whatsapp_instance_id
    AND company_id = p_company_id
    AND ativo = true
  RETURNING * INTO v_instance;

  RETURN v_instance;
END;
$$;

COMMENT ON FUNCTION public.set_default_whatsapp_instance(integer, bigint)
  IS 'Troca default WhatsApp de forma atomica dentro do PostgreSQL para evitar empresa sem default em falhas parciais.';
