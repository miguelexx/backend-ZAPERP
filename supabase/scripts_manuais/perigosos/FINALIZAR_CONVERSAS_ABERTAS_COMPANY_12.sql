-- Finaliza (status_atendimento = 'fechada') TODAS as conversas ainda abertas da empresa 12.
-- "Aberta" aqui = qualquer status diferente de 'fechada' (aberta, em_atendimento, aguardando_cliente, finalizada legado).
-- Espelha exatamente os campos que o botão "Encerrar" (chatController.encerrarChat) limpa,
-- MAS sem enviar mensagem de finalização por WhatsApp e sem registrar histórico por conversa.
-- Grupos (apenas visuais) são ignorados, como no app.
-- Execute no Supabase SQL Editor. Rode o SELECT de pré-visualização ANTES do DO.

-- ============================================================
-- 1) PRÉ-VISUALIZAÇÃO (quantas e quais serão finalizadas)
-- ============================================================
/*
SELECT c.id, c.telefone, c.status_atendimento, c.tipo, cl.nome AS cliente_nome
FROM public.conversas c
LEFT JOIN public.clientes cl ON cl.id = c.cliente_id AND cl.company_id = c.company_id
WHERE c.company_id = 12
  AND c.status_atendimento IS DISTINCT FROM 'fechada'
  AND lower(coalesce(c.tipo, '')) <> 'grupo'
  AND coalesce(c.telefone, '') NOT LIKE '%@g.us'
ORDER BY c.id;

-- Contagem rápida:
SELECT count(*) AS abertas_a_finalizar
FROM public.conversas
WHERE company_id = 12
  AND status_atendimento IS DISTINCT FROM 'fechada'
  AND lower(coalesce(tipo, '')) <> 'grupo'
  AND coalesce(telefone, '') NOT LIKE '%@g.us';
*/

-- ============================================================
-- 2) EXECUÇÃO
-- ============================================================
DO $$
DECLARE
  v_company_id int := 12;
  v_afetadas   int;
BEGIN
  UPDATE public.conversas
  SET
    status_atendimento               = 'fechada',
    finalizacao_motivo               = NULL,
    finalizada_automaticamente       = false,
    finalizada_automaticamente_em    = NULL,
    aguardando_cliente_desde         = NULL,
    ausencia_mensagem_enviada_em     = NULL,
    pagamento_prazo_ate              = NULL,
    pagamento_prazo_origem           = NULL,
    pagamento_concluido_em           = NULL,
    reaberta_falta_interacao_em      = NULL
  WHERE company_id = v_company_id
    AND status_atendimento IS DISTINCT FROM 'fechada'
    AND lower(coalesce(tipo, '')) <> 'grupo'
    AND coalesce(telefone, '') NOT LIKE '%@g.us';

  GET DIAGNOSTICS v_afetadas = ROW_COUNT;
  RAISE NOTICE 'Empresa %: conversas finalizadas = %', v_company_id, v_afetadas;
END $$;
