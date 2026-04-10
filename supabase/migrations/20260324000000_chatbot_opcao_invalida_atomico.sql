-- Função atômica para reservar slot de "opção inválida" (máx 2 por conversa).
-- Evita race condition quando cliente envia várias mensagens de uma vez (fotos, áudios etc).
-- Usa advisory lock para garantir que só uma execução por conversa faça check-and-insert por vez.
CREATE OR REPLACE FUNCTION public.reserve_opcao_invalida_slot(
  p_company_id bigint,
  p_conversa_id bigint,
  p_detalhes jsonb DEFAULT '{}'::jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count int;
  v_lock_key bigint;
BEGIN
  IF p_company_id IS NULL OR p_conversa_id IS NULL THEN
    RETURN false;
  END IF;

  -- Lock único por (company_id, conversa_id) para serializar concorrência
  v_lock_key := abs(hashtext(p_company_id::text || ':' || p_conversa_id::text))::bigint;
  PERFORM pg_advisory_xact_lock(v_lock_key);

  SELECT COUNT(*)::int INTO v_count
  FROM public.bot_logs
  WHERE company_id = p_company_id
    AND conversa_id = p_conversa_id
    AND tipo = 'opcao_invalida';

  IF v_count >= 2 THEN
    RETURN false;
  END IF;

  INSERT INTO public.bot_logs (company_id, conversa_id, tipo, detalhes, criado_em)
  VALUES (p_company_id, p_conversa_id, 'opcao_invalida', COALESCE(p_detalhes, '{}'::jsonb), now());

  RETURN true;
END;
$$;

COMMENT ON FUNCTION public.reserve_opcao_invalida_slot(bigint, bigint, jsonb) IS 'Reserva atomicamente um slot para mensagem "opção inválida" (máx 2 por conversa). Retorna true se reservou, false se limite atingido.';
