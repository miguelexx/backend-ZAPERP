-- Vinculo entre departamentos e grupos do WhatsApp.
-- Grupos continuam em conversas(tipo='grupo'); esta tabela controla apenas visibilidade por setor.

CREATE TABLE IF NOT EXISTS public.departamento_grupos (
  id bigserial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  departamento_id integer NOT NULL REFERENCES public.departamentos(id) ON DELETE CASCADE,
  conversa_id integer NOT NULL REFERENCES public.conversas(id) ON DELETE CASCADE,
  criado_por integer REFERENCES public.usuarios(id) ON DELETE SET NULL,
  criado_em timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT departamento_grupos_unique UNIQUE (company_id, departamento_id, conversa_id)
);

CREATE INDEX IF NOT EXISTS idx_departamento_grupos_company_dep
  ON public.departamento_grupos (company_id, departamento_id, conversa_id);

CREATE INDEX IF NOT EXISTS idx_departamento_grupos_company_conversa
  ON public.departamento_grupos (company_id, conversa_id, departamento_id);

CREATE OR REPLACE FUNCTION public.validate_departamento_grupos_company_group()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  dep_company integer;
  conv_company integer;
  conv_tipo text;
  conv_telefone text;
  user_company integer;
BEGIN
  SELECT d.company_id INTO dep_company
  FROM public.departamentos d
  WHERE d.id = NEW.departamento_id;

  IF dep_company IS NULL OR dep_company <> NEW.company_id THEN
    RAISE EXCEPTION 'departamento_grupos: departamento fora da empresa';
  END IF;

  SELECT c.company_id, c.tipo, c.telefone
    INTO conv_company, conv_tipo, conv_telefone
  FROM public.conversas c
  WHERE c.id = NEW.conversa_id;

  IF conv_company IS NULL OR conv_company <> NEW.company_id THEN
    RAISE EXCEPTION 'departamento_grupos: conversa fora da empresa';
  END IF;

  IF lower(coalesce(conv_tipo, '')) NOT IN ('grupo', 'group')
     AND lower(coalesce(conv_telefone, '')) NOT LIKE '%@g.us' THEN
    RAISE EXCEPTION 'departamento_grupos: conversa nao e grupo';
  END IF;

  IF NEW.criado_por IS NOT NULL THEN
    SELECT u.company_id INTO user_company
    FROM public.usuarios u
    WHERE u.id = NEW.criado_por;

    IF user_company IS NULL OR user_company <> NEW.company_id THEN
      RAISE EXCEPTION 'departamento_grupos: usuario fora da empresa';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_departamento_grupos_company_group ON public.departamento_grupos;

CREATE TRIGGER trg_departamento_grupos_company_group
BEFORE INSERT OR UPDATE OF company_id, departamento_id, conversa_id, criado_por
ON public.departamento_grupos
FOR EACH ROW
EXECUTE FUNCTION public.validate_departamento_grupos_company_group();

COMMENT ON TABLE public.departamento_grupos
  IS 'Controla quais grupos do WhatsApp (conversas tipo grupo) ficam visiveis para cada departamento da empresa.';
