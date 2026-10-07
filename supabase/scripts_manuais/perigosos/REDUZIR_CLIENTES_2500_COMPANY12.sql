-- =============================================================================
-- REDUZIR CLIENTES PARA 2500 — company_id = 12
-- =============================================================================
-- Objetivo: manter apenas os 2500 clientes MAIS ATIVOS da empresa 12 e apagar
-- o restante, priorizando a exclusão de quem NUNCA conversou ou tem MENOS
-- frequência de conversa.
--
-- Critério de ranking (quem FICA = top 2500):
--   1) msgs_recebidas  — nº de mensagens recebidas do cliente (direcao='in')
--                        → mede conversa real de mão dupla; 0 = "nunca conversou"
--   2) msgs_total      — nº total de mensagens (in + out) na(s) conversa(s)
--   3) ultima_atividade— data da última atividade (conversas.ultima_atividade)
--   4) id (desc)       — desempate determinístico
-- Os clientes abaixo da posição 2500 nesse ranking são apagados.
--
-- IMPORTANTE:
--   * NÃO execute sem antes rodar a PARTE 1 (diagnóstico) e conferir os números.
--   * A PARTE 2 está dentro de uma transação. Rode primeiro com o COMMIT
--     comentado + ROLLBACK para validar, depois troque para COMMIT de verdade.
--   * Faça BACKUP / snapshot do banco antes (operação irreversível).
--   * Ajuste v_company_id / v_manter se necessário.
-- =============================================================================


-- =============================================================================
-- PARTE 1 — DIAGNÓSTICO (READ-ONLY, não apaga nada)
-- =============================================================================
-- Rode isto primeiro e confira: total de clientes, quantos serão mantidos,
-- quantos serão apagados e quantos destes "nunca conversaram".

WITH stats AS (
  SELECT
    cl.id AS cliente_id,
    COUNT(m.id) FILTER (WHERE m.direcao = 'in') AS msgs_recebidas,
    COUNT(m.id)                                  AS msgs_total,
    MAX(c.ultima_atividade)                      AS ultima_atividade
  FROM public.clientes cl
  LEFT JOIN public.conversas  c ON c.cliente_id = cl.id AND c.company_id = cl.company_id
  LEFT JOIN public.mensagens  m ON m.conversa_id = c.id
  WHERE cl.company_id = 12
  GROUP BY cl.id
),
ranked AS (
  SELECT
    s.*,
    ROW_NUMBER() OVER (
      ORDER BY msgs_recebidas DESC,
               msgs_total     DESC,
               ultima_atividade DESC NULLS LAST,
               cliente_id      DESC
    ) AS rn
  FROM stats s
)
SELECT
  COUNT(*)                                        AS total_clientes,
  COUNT(*) FILTER (WHERE rn <= 2500)              AS serao_mantidos,
  COUNT(*) FILTER (WHERE rn >  2500)              AS serao_apagados,
  COUNT(*) FILTER (WHERE rn > 2500 AND msgs_recebidas = 0) AS apagados_nunca_conversaram,
  COUNT(*) FILTER (WHERE rn > 2500 AND msgs_recebidas > 0) AS apagados_com_alguma_conversa
FROM ranked;

-- (Opcional) Espiar os 30 clientes "no limite" que seriam apagados primeiro,
-- para sanidade — os de menor atividade entre os que serão removidos:
--
-- WITH stats AS ( ... mesmo CTE acima ... ), ranked AS ( ... )
-- SELECT cliente_id, msgs_recebidas, msgs_total, ultima_atividade, rn
-- FROM ranked WHERE rn > 2500 ORDER BY rn ASC LIMIT 30;


-- =============================================================================
-- PARTE 2 — EXCLUSÃO (DESTRUTIVO) — rode só depois de validar a PARTE 1
-- =============================================================================
-- Primeira execução: deixe o ROLLBACK ativo (último comando) para testar sem
-- gravar. Confira os NOTICE. Depois comente o ROLLBACK e descomente o COMMIT.

BEGIN;

DO $$
DECLARE
  v_company_id int := 12;    -- empresa alvo
  v_manter     int := 2500;  -- quantos clientes manter
  v_qtd_cli    int;
  v_qtd_conv   int;
  v_total      int;
BEGIN
  -- Guarda de segurança: nunca rodar em company errada
  IF v_company_id IS NULL OR v_manter IS NULL OR v_manter < 1 THEN
    RAISE EXCEPTION 'Parametros invalidos.';
  END IF;

  SELECT COUNT(*) INTO v_total FROM public.clientes WHERE company_id = v_company_id;
  RAISE NOTICE 'Total de clientes na empresa %: %', v_company_id, v_total;

  IF v_total <= v_manter THEN
    RAISE NOTICE 'Empresa ja tem % clientes (<= %). Nada a apagar.', v_total, v_manter;
    RETURN;
  END IF;

  -- -------------------------------------------------------------------------
  -- 1) Selecionar os clientes a APAGAR (fora do top v_manter) numa temp table
  -- -------------------------------------------------------------------------
  CREATE TEMP TABLE _cli_del ON COMMIT DROP AS
  WITH stats AS (
    SELECT
      cl.id AS cliente_id,
      COUNT(m.id) FILTER (WHERE m.direcao = 'in') AS msgs_recebidas,
      COUNT(m.id)                                  AS msgs_total,
      MAX(c.ultima_atividade)                      AS ultima_atividade
    FROM public.clientes cl
    LEFT JOIN public.conversas  c ON c.cliente_id = cl.id AND c.company_id = cl.company_id
    LEFT JOIN public.mensagens  m ON m.conversa_id = c.id
    WHERE cl.company_id = v_company_id
    GROUP BY cl.id
  ),
  ranked AS (
    SELECT cliente_id,
           ROW_NUMBER() OVER (
             ORDER BY msgs_recebidas DESC,
                      msgs_total     DESC,
                      ultima_atividade DESC NULLS LAST,
                      cliente_id      DESC
           ) AS rn
    FROM stats
  )
  SELECT cliente_id FROM ranked WHERE rn > v_manter;

  CREATE INDEX ON _cli_del (cliente_id);
  GET DIAGNOSTICS v_qtd_cli = ROW_COUNT;  -- nota: ROW_COUNT do CREATE..AS
  SELECT COUNT(*) INTO v_qtd_cli FROM _cli_del;

  -- -------------------------------------------------------------------------
  -- 2) Conversas desses clientes (dentro da mesma empresa)
  -- -------------------------------------------------------------------------
  CREATE TEMP TABLE _conv_del ON COMMIT DROP AS
  SELECT c.id AS conversa_id
  FROM public.conversas c
  WHERE c.company_id = v_company_id
    AND c.cliente_id IN (SELECT cliente_id FROM _cli_del);

  CREATE INDEX ON _conv_del (conversa_id);
  SELECT COUNT(*) INTO v_qtd_conv FROM _conv_del;

  RAISE NOTICE 'Clientes a apagar: % | Conversas a apagar: %', v_qtd_cli, v_qtd_conv;

  -- -------------------------------------------------------------------------
  -- 3) Apagar dependências na ordem correta (respeitando FKs RESTRICT)
  --    Mesma cadeia validada em EXCLUIR_CLIENTE_ESPECIFICO.sql
  -- -------------------------------------------------------------------------

  -- avaliacoes_atendimento (via atendimentos e via conversa)
  DELETE FROM public.avaliacoes_atendimento
  WHERE atendimento_id IN (
          SELECT id FROM public.atendimentos
          WHERE conversa_id IN (SELECT conversa_id FROM _conv_del))
     OR conversa_id IN (SELECT conversa_id FROM _conv_del);

  DELETE FROM public.mensagens_ocultas
  WHERE conversa_id IN (SELECT conversa_id FROM _conv_del);

  DELETE FROM public.conversa_unreads
  WHERE conversa_id IN (SELECT conversa_id FROM _conv_del);

  DELETE FROM public.atendimentos
  WHERE conversa_id IN (SELECT conversa_id FROM _conv_del);

  DELETE FROM public.historico_atendimentos
  WHERE conversa_id IN (SELECT conversa_id FROM _conv_del);

  DELETE FROM public.conversa_tags
  WHERE conversa_id IN (SELECT conversa_id FROM _conv_del);

  DELETE FROM public.bot_logs
  WHERE conversa_id IN (SELECT conversa_id FROM _conv_del);

  DELETE FROM public.mensagens
  WHERE conversa_id IN (SELECT conversa_id FROM _conv_del);

  -- Desvincular conversa do cliente antes de apagar (evita FK)
  UPDATE public.conversas SET cliente_id = NULL
  WHERE id IN (SELECT conversa_id FROM _conv_del);

  DELETE FROM public.conversas
  WHERE id IN (SELECT conversa_id FROM _conv_del);

  -- Dependências diretas do cliente
  DELETE FROM public.campanha_envios
  WHERE cliente_id IN (SELECT cliente_id FROM _cli_del);

  DELETE FROM public.cliente_tags
  WHERE cliente_id IN (SELECT cliente_id FROM _cli_del);

  DELETE FROM public.contato_opt_in
  WHERE cliente_id IN (SELECT cliente_id FROM _cli_del);

  DELETE FROM public.contato_opt_out
  WHERE cliente_id IN (SELECT cliente_id FROM _cli_del);

  DELETE FROM public.avaliacoes_atendimento
  WHERE cliente_id IN (SELECT cliente_id FROM _cli_del);

  -- -------------------------------------------------------------------------
  -- 4) Apagar os clientes
  --    FKs com ON DELETE SET NULL (crm_leads, helpdesk_tickets,
  --    disparo_campanha_destinatarios) e CASCADE (cliente_nomes_vinculados,
  --    conversa_usuario_prefs, conversa_atendentes etc.) são tratadas
  --    automaticamente pelo banco — não bloqueiam a exclusão.
  -- -------------------------------------------------------------------------
  DELETE FROM public.clientes
  WHERE company_id = v_company_id
    AND id IN (SELECT cliente_id FROM _cli_del);

  SELECT COUNT(*) INTO v_total FROM public.clientes WHERE company_id = v_company_id;
  RAISE NOTICE 'CONCLUIDO. Clientes restantes na empresa %: % (esperado: %)',
               v_company_id, v_total, v_manter;
END $$;

-- ⚠️ 1ª execução (teste sem gravar): mantenha o ROLLBACK abaixo.
ROLLBACK;

-- ✅ Execução DEFINITIVA: comente o ROLLBACK acima e descomente o COMMIT:
-- COMMIT;
