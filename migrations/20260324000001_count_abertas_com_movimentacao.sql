-- Contagem de conversas abertas COM movimentação (mensagem ou atendente assumiu)
-- Usado pelo dashboard para KPIs: exclui conversas "Sem mensagens" / sem atividade
CREATE OR REPLACE FUNCTION public.count_conversas_abertas_com_movimentacao(
  p_company_id bigint,
  p_from_iso timestamptz DEFAULT NULL,
  p_to_iso timestamptz DEFAULT NULL
)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT COUNT(*)::bigint
  FROM public.conversas c
  WHERE c.company_id = p_company_id
    AND c.status_atendimento = 'aberta'
    AND (p_from_iso IS NULL OR c.criado_em >= p_from_iso)
    AND (p_to_iso IS NULL OR c.criado_em <= p_to_iso)
    AND (
      c.atendente_id IS NOT NULL
      OR EXISTS (SELECT 1 FROM public.mensagens m WHERE m.conversa_id = c.id AND m.company_id = c.company_id LIMIT 1)
    );
$$;

COMMENT ON FUNCTION public.count_conversas_abertas_com_movimentacao(bigint, timestamptz, timestamptz)
IS 'Conta conversas abertas com movimentação (mensagem ou atendente assumiu). Exclui "Sem mensagens".';
