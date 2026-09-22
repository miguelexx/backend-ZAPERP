-- Ao encerrar o atendimento (fechada ou finalizada), zera o contador da RPC
-- reserve_opcao_invalida_slot para a próxima vez que o cliente passar pela triagem na mesma conversa.
-- Cobertura extra quando o status é alterado pelo painel/Supabase sem passar pelo Node (debounce em memória continua só no servidor de API).

CREATE OR REPLACE FUNCTION public.trg_conversas_reset_opcao_invalida_on_finalize()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.status_atendimento IS DISTINCT FROM OLD.status_atendimento
     AND NEW.status_atendimento IN ('fechada', 'finalizada')
  THEN
    DELETE FROM public.bot_logs
    WHERE company_id = NEW.company_id
      AND conversa_id = NEW.id
      AND tipo = 'opcao_invalida';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS conversas_reset_opcao_invalida_on_finalize ON public.conversas;
CREATE TRIGGER conversas_reset_opcao_invalida_on_finalize
  AFTER UPDATE OF status_atendimento ON public.conversas
  FOR EACH ROW
  EXECUTE PROCEDURE public.trg_conversas_reset_opcao_invalida_on_finalize();

COMMENT ON FUNCTION public.trg_conversas_reset_opcao_invalida_on_finalize IS 'Remove logs opcao_invalida ao finalizar conversa para novo ciclo de limite da triagem.';
