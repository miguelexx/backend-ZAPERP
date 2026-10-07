-- Serializa inclusões de co-atendentes com encerramento/transferência e valida o
-- limite no banco. O SELECT seguido de INSERT no controller não é atômico.
BEGIN;

CREATE OR REPLACE FUNCTION public.validar_conversa_atendente_ativo()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  conversa public.conversas%ROWTYPE;
  total integer;
BEGIN
  IF NEW.ativo IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  SELECT * INTO conversa FROM public.conversas
    WHERE id = NEW.conversa_id AND company_id = NEW.company_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Conversa não encontrada nesta empresa.';
  END IF;
  IF lower(trim(coalesce(conversa.status_atendimento, ''))) IN ('fechada', 'encerrada', 'finalizada', 'finalizado') THEN
    RAISE EXCEPTION 'Reabra a conversa antes de adicionar atendente.';
  END IF;
  IF conversa.tipo = 'grupo' OR coalesce(conversa.telefone, '') LIKE '%@g.us%' THEN
    RAISE EXCEPTION 'Não é possível adicionar atendente em conversa de grupo.';
  END IF;
  IF conversa.atendente_id IS NULL THEN
    RAISE EXCEPTION 'Assuma a conversa antes de adicionar co-atendente.';
  END IF;
  IF conversa.atendente_id = NEW.usuario_id THEN
    RAISE EXCEPTION 'Este atendente já é o responsável principal da conversa.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.usuarios WHERE id = NEW.usuario_id AND company_id = NEW.company_id AND ativo = true AND perfil IN ('admin', 'supervisor', 'atendente')) THEN
    RAISE EXCEPTION 'Atendente não encontrado ou inativo nesta empresa.';
  END IF;

  -- Pedido duplicado deve chegar ao índice único, sem virar erro de lotação.
  IF EXISTS (SELECT 1 FROM public.conversa_atendentes
      WHERE company_id = NEW.company_id AND conversa_id = NEW.conversa_id
        AND usuario_id = NEW.usuario_id AND ativo = true AND id <> NEW.id) THEN
    RAISE unique_violation USING MESSAGE = 'Este atendente já participa da conversa.';
  END IF;
  SELECT count(*) INTO total FROM public.conversa_atendentes
    WHERE company_id = NEW.company_id AND conversa_id = NEW.conversa_id
      AND ativo = true AND id <> NEW.id;
  IF total >= 3 THEN
    RAISE EXCEPTION 'Limite de 4 atendentes por conversa atingido (1 principal + 3 co-atendentes).';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS conversa_atendentes_guard ON public.conversa_atendentes;
CREATE TRIGGER conversa_atendentes_guard
BEFORE INSERT OR UPDATE OF ativo, usuario_id, conversa_id, company_id
ON public.conversa_atendentes
FOR EACH ROW EXECUTE FUNCTION public.validar_conversa_atendente_ativo();

COMMIT;
