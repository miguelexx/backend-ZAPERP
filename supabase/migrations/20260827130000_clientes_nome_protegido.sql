-- Proteção persistente do nome do contato (importação por planilha / edição manual).
-- ZapERP: isolamento por company_id permanece nas queries da aplicação; estas colunas
-- apenas impedem que webhooks, sync e upserts automáticos substituam um nome protegido.

ALTER TABLE public.clientes
  ADD COLUMN IF NOT EXISTS nome_origem text,
  ADD COLUMN IF NOT EXISTS nome_protegido boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS nome_override boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.clientes.nome_origem IS
  'Origem persistente do nome exibido: import_planilha | manual. Fontes automáticas não gravam origem autorizada.';
COMMENT ON COLUMN public.clientes.nome_protegido IS
  'Quando true, fluxos automáticos (webhook, sync, mensagens, upsert) não podem alterar clientes.nome.';
COMMENT ON COLUMN public.clientes.nome_override IS
  'Flag transiente de intenção: só a importação confirmada e a edição manual enviam true. O trigger sempre persiste false.';

CREATE INDEX IF NOT EXISTS idx_clientes_company_nome_protegido
  ON public.clientes (company_id)
  WHERE nome_protegido IS TRUE;

CREATE OR REPLACE FUNCTION public.proteger_nome_cliente()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;

  -- Impede desligar a proteção sem override autorizado.
  IF OLD.nome_protegido IS TRUE
     AND NEW.nome_protegido IS DISTINCT FROM TRUE
     AND NEW.nome_override IS NOT TRUE THEN
    NEW.nome_protegido := TRUE;
    NEW.nome_origem := OLD.nome_origem;
  END IF;

  IF OLD.nome_protegido IS TRUE
     AND NEW.nome IS DISTINCT FROM OLD.nome THEN
    IF NEW.nome_override IS TRUE
       AND NEW.nome_origem IN ('manual', 'import_planilha') THEN
      NEW.nome_protegido := TRUE;
    ELSE
      NEW.nome := OLD.nome;
      NEW.nome_origem := OLD.nome_origem;
      NEW.nome_protegido := TRUE;
    END IF;
  END IF;

  NEW.nome_override := FALSE;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_proteger_nome_cliente ON public.clientes;
CREATE TRIGGER trg_proteger_nome_cliente
  BEFORE UPDATE ON public.clientes
  FOR EACH ROW
  EXECUTE FUNCTION public.proteger_nome_cliente();

COMMENT ON FUNCTION public.proteger_nome_cliente() IS
  'Reverte alteração automática de clientes.nome quando nome_protegido=true, salvo override autorizado (manual | import_planilha).';
