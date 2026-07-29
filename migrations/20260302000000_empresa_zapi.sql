-- Configuração de instância Z-API por empresa (multi-tenant).
-- Uma instância por company_id.

CREATE TABLE IF NOT EXISTS public.empresa_zapi (
  id           bigserial PRIMARY KEY,
  company_id   integer    NOT NULL UNIQUE REFERENCES public.empresas(id) ON DELETE CASCADE,
  instance_id  text       NOT NULL,
  instance_token text     NOT NULL,
  client_token text       NOT NULL,
  ativo        boolean    NOT NULL DEFAULT true,
  criado_em    timestamp with time zone DEFAULT now(),
  atualizado_em timestamp with time zone DEFAULT now()
);

-- Gatilho para manter atualizado_em.
CREATE OR REPLACE FUNCTION public.set_updated_at_empresa_zapi()
RETURNS trigger AS $$
BEGIN
  NEW.atualizado_em = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'set_updated_at_empresa_zapi_trg'
  ) THEN
    CREATE TRIGGER set_updated_at_empresa_zapi_trg
    BEFORE UPDATE ON public.empresa_zapi
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at_empresa_zapi();
  END IF;
END;
$$;

