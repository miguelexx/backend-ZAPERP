-- Excluir cliente e conversas específicas pelo telefone
-- Ajuste v_telefone e v_company_id abaixo e execute no Supabase SQL Editor

DO $$
DECLARE
  v_telefone text := '555592130906';  -- Telefone da Laura
  v_company_id int := 3;               -- Empresa 3
  v_conversa_ids int[];
  v_cliente_ids int[];
BEGIN
  -- 1) Encontrar conversas (telefone exato ou variações 12/13 dígitos)
  SELECT array_agg(DISTINCT c.id)
  INTO v_conversa_ids
  FROM public.conversas c
  LEFT JOIN public.clientes cl ON cl.id = c.cliente_id AND cl.company_id = c.company_id
  WHERE c.company_id = v_company_id
    AND (
      c.telefone = v_telefone
      OR c.telefone LIKE '%92130906'   -- últimos 8 dígitos (pega 555592130906 e 5555992130906)
      OR cl.telefone = v_telefone
      OR cl.telefone LIKE '%92130906'
    );

  -- 2) Encontrar clientes (telefone ou nome)
  SELECT array_agg(DISTINCT id)
  INTO v_cliente_ids
  FROM public.clientes
  WHERE company_id = v_company_id
    AND (telefone = v_telefone OR telefone LIKE '%92130906' OR nome ILIKE '%Laura Cristiny%');

  -- 3) Reunir TODAS as conversas: por telefone OU por cliente_id
  SELECT array_agg(DISTINCT id)
  INTO v_conversa_ids
  FROM public.conversas
  WHERE company_id = v_company_id
    AND (
      telefone = v_telefone
      OR telefone LIKE '%92130906'
      OR cliente_id = ANY(COALESCE(v_cliente_ids, ARRAY[]::int[]))
    );

  v_conversa_ids := COALESCE(v_conversa_ids, ARRAY[]::int[]);
  v_cliente_ids := COALESCE(v_cliente_ids, ARRAY[]::int[]);

  IF array_length(v_conversa_ids, 1) IS NULL AND array_length(v_cliente_ids, 1) IS NULL THEN
    RAISE NOTICE 'Nenhum registro encontrado para telefone % ou nome Laura Cristiny. Verifique company_id e telefone.', v_telefone;
    RETURN;
  END IF;

  RAISE NOTICE 'Conversas a excluir: %', v_conversa_ids;
  RAISE NOTICE 'Clientes a excluir: %', v_cliente_ids;

  -- 4) Excluir na ordem correta (respeitando FKs)

  -- avaliacoes_atendimento (via atendimentos)
  DELETE FROM public.avaliacoes_atendimento
  WHERE atendimento_id IN (SELECT id FROM public.atendimentos WHERE conversa_id = ANY(v_conversa_ids))
     OR conversa_id = ANY(v_conversa_ids);

  -- mensagens_ocultas
  DELETE FROM public.mensagens_ocultas WHERE conversa_id = ANY(v_conversa_ids);

  -- conversa_unreads
  DELETE FROM public.conversa_unreads WHERE conversa_id = ANY(v_conversa_ids);

  -- atendimentos
  DELETE FROM public.atendimentos WHERE conversa_id = ANY(v_conversa_ids);

  -- historico_atendimentos
  DELETE FROM public.historico_atendimentos WHERE conversa_id = ANY(v_conversa_ids);

  -- conversa_tags
  DELETE FROM public.conversa_tags WHERE conversa_id = ANY(v_conversa_ids);

  -- bot_logs (se existir)
  DELETE FROM public.bot_logs WHERE conversa_id = ANY(v_conversa_ids);

  -- mensagens
  DELETE FROM public.mensagens WHERE conversa_id = ANY(v_conversa_ids);

  -- Desvincular conversas do cliente antes de excluir (evita FK)
  UPDATE public.conversas SET cliente_id = NULL WHERE id = ANY(v_conversa_ids);

  -- conversas
  DELETE FROM public.conversas WHERE id = ANY(v_conversa_ids);

  -- Dependências do cliente
  DELETE FROM public.campanha_envios WHERE cliente_id = ANY(v_cliente_ids);
  DELETE FROM public.cliente_tags WHERE cliente_id = ANY(v_cliente_ids);
  DELETE FROM public.contato_opt_in WHERE cliente_id = ANY(v_cliente_ids);
  DELETE FROM public.contato_opt_out WHERE cliente_id = ANY(v_cliente_ids);
  DELETE FROM public.avaliacoes_atendimento WHERE cliente_id = ANY(v_cliente_ids);

  -- cliente
  DELETE FROM public.clientes WHERE id = ANY(v_cliente_ids);

  RAISE NOTICE 'Exclusão concluída. Conversas: %, Clientes: %', array_length(v_conversa_ids, 1), array_length(v_cliente_ids, 1);
END $$;
