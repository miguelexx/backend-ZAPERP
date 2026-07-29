-- Garante que usuario_departamentos nao cruze usuarios/departamentos de empresas diferentes.

CREATE OR REPLACE FUNCTION public.validate_usuario_departamentos_company()
RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.usuarios u
    WHERE u.id = NEW.usuario_id
      AND u.company_id = NEW.company_id
  ) THEN
    RAISE EXCEPTION 'usuario_departamentos invalido: usuario % nao pertence a empresa %', NEW.usuario_id, NEW.company_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.departamentos d
    WHERE d.id = NEW.departamento_id
      AND d.company_id = NEW.company_id
  ) THEN
    RAISE EXCEPTION 'usuario_departamentos invalido: departamento % nao pertence a empresa %', NEW.departamento_id, NEW.company_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validate_usuario_departamentos_company ON public.usuario_departamentos;

CREATE TRIGGER trg_validate_usuario_departamentos_company
BEFORE INSERT OR UPDATE ON public.usuario_departamentos
FOR EACH ROW
EXECUTE FUNCTION public.validate_usuario_departamentos_company();

CREATE INDEX IF NOT EXISTS idx_departamentos_company_id_id
  ON public.departamentos (company_id, id);

CREATE INDEX IF NOT EXISTS idx_usuarios_company_id_id
  ON public.usuarios (company_id, id);
