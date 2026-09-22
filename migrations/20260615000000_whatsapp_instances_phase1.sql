-- Fase 1 multi-instancia WhatsApp/UltraMsg.
-- Migration aditiva: nao remove nem altera destrutivamente empresa_zapi.

CREATE TABLE IF NOT EXISTS public.whatsapp_instances (
  id bigserial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'ultramsg',
  nome text NOT NULL DEFAULT 'WhatsApp principal',
  descricao text,
  instance_id text NOT NULL,
  instance_token text NOT NULL,
  client_token text,
  telefone_conectado text,
  display_phone text,
  ativo boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'unknown',
  status_at timestamp with time zone,
  ultimo_qr_em timestamp with time zone,
  ultimo_sync_em timestamp with time zone,
  ultimo_webhook_em timestamp with time zone,
  ultimo_erro text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  legacy_empresa_zapi_id bigint REFERENCES public.empresa_zapi(id) ON DELETE SET NULL,
  criado_em timestamp with time zone NOT NULL DEFAULT now(),
  atualizado_em timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT whatsapp_instances_provider_chk CHECK (provider IN ('ultramsg')),
  CONSTRAINT whatsapp_instances_instance_id_not_blank CHECK (length(btrim(instance_id)) > 0),
  CONSTRAINT whatsapp_instances_instance_token_not_blank CHECK (length(btrim(instance_token)) > 0)
);

COMMENT ON TABLE public.whatsapp_instances IS 'Instancias WhatsApp por empresa. Fase 1 multi-instancia; empresa_zapi permanece como legado/default.';
COMMENT ON COLUMN public.whatsapp_instances.instance_token IS 'Token sensivel da API UltraMsg. Nunca expor em respostas publicas.';
COMMENT ON COLUMN public.whatsapp_instances.legacy_empresa_zapi_id IS 'Referencia opcional para a linha legada empresa_zapi usada no backfill inicial.';

CREATE OR REPLACE FUNCTION public.set_updated_at_whatsapp_instances()
RETURNS trigger AS $$
BEGIN
  NEW.atualizado_em = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'set_updated_at_whatsapp_instances_trg'
  ) THEN
    CREATE TRIGGER set_updated_at_whatsapp_instances_trg
    BEFORE UPDATE ON public.whatsapp_instances
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at_whatsapp_instances();
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_whatsapp_instances_company_active
  ON public.whatsapp_instances (company_id, ativo);

CREATE INDEX IF NOT EXISTS idx_whatsapp_instances_provider_instance_id
  ON public.whatsapp_instances (provider, instance_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_instances_company_provider_instance
  ON public.whatsapp_instances (company_id, provider, instance_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_instances_default_active
  ON public.whatsapp_instances (company_id)
  WHERE ativo = true AND is_default = true;

-- Backfill seguro: cria uma instancia default para cada linha legada ativa.
-- ON CONFLICT evita duplicar se a migration for reexecutada.
INSERT INTO public.whatsapp_instances (
  company_id,
  provider,
  nome,
  instance_id,
  instance_token,
  client_token,
  ativo,
  is_default,
  status,
  legacy_empresa_zapi_id,
  criado_em,
  atualizado_em
)
SELECT
  ez.company_id,
  'ultramsg',
  'WhatsApp principal',
  ez.instance_id,
  ez.instance_token,
  ez.client_token,
  ez.ativo,
  ez.ativo,
  'unknown',
  ez.id,
  COALESCE(ez.criado_em, now()),
  COALESCE(ez.atualizado_em, now())
FROM public.empresa_zapi ez
WHERE ez.ativo = true
  AND length(btrim(COALESCE(ez.instance_id, ''))) > 0
  AND length(btrim(COALESCE(ez.instance_token, ''))) > 0
ON CONFLICT (company_id, provider, instance_id) DO UPDATE
SET
  instance_token = EXCLUDED.instance_token,
  client_token = EXCLUDED.client_token,
  ativo = EXCLUDED.ativo,
  is_default = CASE
    WHEN public.whatsapp_instances.is_default THEN true
    ELSE EXCLUDED.is_default
  END,
  legacy_empresa_zapi_id = COALESCE(public.whatsapp_instances.legacy_empresa_zapi_id, EXCLUDED.legacy_empresa_zapi_id),
  atualizado_em = now();

-- Se alguma empresa ficou com instancia ativa mas sem default, escolhe a menor id.
WITH first_active AS (
  SELECT DISTINCT ON (company_id) id
  FROM public.whatsapp_instances wi
  WHERE wi.ativo = true
    AND NOT EXISTS (
      SELECT 1
      FROM public.whatsapp_instances d
      WHERE d.company_id = wi.company_id
        AND d.ativo = true
        AND d.is_default = true
    )
  ORDER BY company_id, id
)
UPDATE public.whatsapp_instances wi
SET is_default = true
FROM first_active fa
WHERE wi.id = fa.id;

ALTER TABLE IF EXISTS public.conversas
  ADD COLUMN IF NOT EXISTS whatsapp_instance_id bigint;

ALTER TABLE IF EXISTS public.mensagens
  ADD COLUMN IF NOT EXISTS whatsapp_instance_id bigint;

ALTER TABLE IF EXISTS public.webhook_logs
  ADD COLUMN IF NOT EXISTS whatsapp_instance_id bigint;

ALTER TABLE IF EXISTS public.whatsapp_envio_guard_logs
  ADD COLUMN IF NOT EXISTS whatsapp_instance_id bigint;

ALTER TABLE IF EXISTS public.campanhas
  ADD COLUMN IF NOT EXISTS whatsapp_instance_id bigint;

ALTER TABLE IF EXISTS public.campanha_envios
  ADD COLUMN IF NOT EXISTS whatsapp_instance_id bigint;

DO $$
BEGIN
  IF to_regclass('public.conversas') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conversas_whatsapp_instance_id_fkey') THEN
    ALTER TABLE public.conversas
      ADD CONSTRAINT conversas_whatsapp_instance_id_fkey
      FOREIGN KEY (whatsapp_instance_id) REFERENCES public.whatsapp_instances(id) ON DELETE SET NULL NOT VALID;
  END IF;

  IF to_regclass('public.mensagens') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mensagens_whatsapp_instance_id_fkey') THEN
    ALTER TABLE public.mensagens
      ADD CONSTRAINT mensagens_whatsapp_instance_id_fkey
      FOREIGN KEY (whatsapp_instance_id) REFERENCES public.whatsapp_instances(id) ON DELETE SET NULL NOT VALID;
  END IF;

  IF to_regclass('public.webhook_logs') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'webhook_logs_whatsapp_instance_id_fkey') THEN
    ALTER TABLE public.webhook_logs
      ADD CONSTRAINT webhook_logs_whatsapp_instance_id_fkey
      FOREIGN KEY (whatsapp_instance_id) REFERENCES public.whatsapp_instances(id) ON DELETE SET NULL NOT VALID;
  END IF;

  IF to_regclass('public.whatsapp_envio_guard_logs') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_envio_guard_logs_whatsapp_instance_id_fkey') THEN
    ALTER TABLE public.whatsapp_envio_guard_logs
      ADD CONSTRAINT whatsapp_envio_guard_logs_whatsapp_instance_id_fkey
      FOREIGN KEY (whatsapp_instance_id) REFERENCES public.whatsapp_instances(id) ON DELETE SET NULL NOT VALID;
  END IF;

  IF to_regclass('public.campanhas') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'campanhas_whatsapp_instance_id_fkey') THEN
    ALTER TABLE public.campanhas
      ADD CONSTRAINT campanhas_whatsapp_instance_id_fkey
      FOREIGN KEY (whatsapp_instance_id) REFERENCES public.whatsapp_instances(id) ON DELETE SET NULL NOT VALID;
  END IF;

  IF to_regclass('public.campanha_envios') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'campanha_envios_whatsapp_instance_id_fkey') THEN
    ALTER TABLE public.campanha_envios
      ADD CONSTRAINT campanha_envios_whatsapp_instance_id_fkey
      FOREIGN KEY (whatsapp_instance_id) REFERENCES public.whatsapp_instances(id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.conversas') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_conversas_whatsapp_instance_id
      ON public.conversas (whatsapp_instance_id);
  END IF;

  IF to_regclass('public.mensagens') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_mensagens_whatsapp_instance_id
      ON public.mensagens (whatsapp_instance_id);
  END IF;

  IF to_regclass('public.webhook_logs') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_webhook_logs_whatsapp_instance_id
      ON public.webhook_logs (whatsapp_instance_id);
  END IF;

  IF to_regclass('public.whatsapp_envio_guard_logs') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_whatsapp_envio_guard_logs_instance_id
      ON public.whatsapp_envio_guard_logs (whatsapp_instance_id);
  END IF;

  IF to_regclass('public.campanhas') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_campanhas_whatsapp_instance_id
      ON public.campanhas (whatsapp_instance_id);
  END IF;

  IF to_regclass('public.campanha_envios') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_campanha_envios_whatsapp_instance_id
      ON public.campanha_envios (whatsapp_instance_id);
  END IF;
END $$;
