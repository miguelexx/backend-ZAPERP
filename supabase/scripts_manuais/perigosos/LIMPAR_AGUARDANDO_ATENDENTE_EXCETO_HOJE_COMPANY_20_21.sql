-- Remove da fila "Aguardando atendente" (modo simples) as conversas INDIVIDUAIS das
-- empresas 20 e 21, EXCETO as com última atividade de HOJE (America/Sao_Paulo).
--
-- "Aguardando atendente" (individual, modo simples) = conversas.modo_simples_aguardando = 'atendente'.
-- Tirar da fila = modo_simples_aguardando = NULL  (mesmo efeito do botão "Marcar como lida"
-- do app, ver services/atendimentoModoSimplesService.js -> limparAguardandoAtendenteModoSimples).
-- Nova mensagem inbound recalcula o estado normalmente (recalcularStatusPorUltimaMensagem).
--
-- "Hoje" = (ultima_atividade AT TIME ZONE 'America/Sao_Paulo')::date = data local de hoje.
-- Grupos não dependem desta coluna (usam conversa_unreads); no momento da análise havia 0 grupos
-- nesta fila para as empresas 20 e 21, então ficam fora do escopo.
--
-- Execute no Supabase SQL Editor. Rode o SELECT de pré-visualização ANTES do DO.

-- ============================================================
-- 1) PRÉ-VISUALIZAÇÃO (quantas serão limpas x mantidas)
-- ============================================================
/*
SELECT
  company_id,
  count(*) FILTER (
    WHERE (ultima_atividade AT TIME ZONE 'America/Sao_Paulo')::date
          < (now() AT TIME ZONE 'America/Sao_Paulo')::date
  ) AS antigas_a_limpar,
  count(*) FILTER (
    WHERE (ultima_atividade AT TIME ZONE 'America/Sao_Paulo')::date
          = (now() AT TIME ZONE 'America/Sao_Paulo')::date
  ) AS de_hoje_mantidas,
  count(*) AS total_na_fila
FROM public.conversas
WHERE company_id IN (20, 21)
  AND modo_simples_aguardando = 'atendente'
  AND lower(coalesce(tipo, '')) <> 'grupo'
  AND coalesce(telefone, '') NOT LIKE '%@g.us'
GROUP BY company_id
ORDER BY company_id;
*/

-- ============================================================
-- 2) EXECUÇÃO
-- ============================================================
DO $$
DECLARE
  v_afetadas int;
BEGIN
  UPDATE public.conversas
  SET modo_simples_aguardando = NULL
  WHERE company_id IN (20, 21)
    AND modo_simples_aguardando = 'atendente'
    AND lower(coalesce(tipo, '')) <> 'grupo'
    AND coalesce(telefone, '') NOT LIKE '%@g.us'
    AND (ultima_atividade AT TIME ZONE 'America/Sao_Paulo')::date
        < (now() AT TIME ZONE 'America/Sao_Paulo')::date;

  GET DIAGNOSTICS v_afetadas = ROW_COUNT;
  RAISE NOTICE 'Conversas removidas da fila Aguardando atendente (empresas 20 e 21, exceto hoje): %', v_afetadas;
END $$;
