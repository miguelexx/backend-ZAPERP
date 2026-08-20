-- Encaminhamento atômico e balanceado quando o cliente não escolhe um setor no menu.
CREATE INDEX IF NOT EXISTS idx_bot_logs_company_tipo_criado
  ON public.bot_logs (company_id, tipo, criado_em DESC);

CREATE OR REPLACE FUNCTION public.claim_chatbot_no_selection_route(
  p_company_id integer,
  p_conversa_id integer,
  p_departamento_ids integer[],
  p_limite_atividade timestamptz,
  p_prazo_minutos integer
)
RETURNS TABLE(conversa_id integer, departamento_id integer, departamento_nome text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_departamento_id integer;
  v_departamento_nome text;
  v_conversa_id integer;
BEGIN
  IF p_company_id IS NULL OR p_conversa_id IS NULL OR COALESCE(array_length(p_departamento_ids, 1), 0) = 0 THEN
    RETURN;
  END IF;

  -- Serializa somente os encaminhamentos automáticos desta empresa, preservando o balanceamento.
  PERFORM pg_advisory_xact_lock(728451, p_company_id);

  IF EXISTS (
    SELECT 1 FROM public.bot_logs bl
    WHERE bl.company_id = p_company_id
      AND bl.conversa_id = p_conversa_id
      AND bl.tipo = 'opcao_valida'
  ) THEN
    RETURN;
  END IF;

  SELECT d.id, d.nome
    INTO v_departamento_id, v_departamento_nome
  FROM public.departamentos d
  WHERE d.company_id = p_company_id
    AND d.id = ANY(p_departamento_ids)
  ORDER BY (
    SELECT count(*)
    FROM public.conversas carga
    WHERE carga.company_id = p_company_id
      AND carga.departamento_id = d.id
      AND COALESCE(carga.status_atendimento, '') NOT IN ('fechada', 'finalizada')
  ) ASC, d.id ASC
  LIMIT 1;

  IF v_departamento_id IS NULL THEN RETURN; END IF;

  UPDATE public.conversas c
  SET departamento_id = v_departamento_id,
      atendente_id = NULL,
      status_atendimento = 'aberta',
      ultima_atividade = now()
  WHERE c.id = p_conversa_id
    AND c.company_id = p_company_id
    AND c.departamento_id IS NULL
    AND c.atendente_id IS NULL
    AND COALESCE(c.status_atendimento, '') NOT IN ('fechada', 'finalizada')
    AND c.ultima_atividade <= p_limite_atividade
  RETURNING c.id INTO v_conversa_id;

  IF v_conversa_id IS NULL THEN RETURN; END IF;

  INSERT INTO public.bot_logs (company_id, conversa_id, tipo, detalhes)
  VALUES (
    p_company_id,
    v_conversa_id,
    'encaminhamento_automatico_sem_escolha',
    jsonb_build_object(
      'departamento_id', v_departamento_id,
      'departamento_nome', v_departamento_nome,
      'prazo_minutos', p_prazo_minutos
    )
  );

  RETURN QUERY SELECT v_conversa_id, v_departamento_id, v_departamento_nome;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_chatbot_no_selection_route(integer, integer, integer[], timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_chatbot_no_selection_route(integer, integer, integer[], timestamptz, integer) TO service_role;
