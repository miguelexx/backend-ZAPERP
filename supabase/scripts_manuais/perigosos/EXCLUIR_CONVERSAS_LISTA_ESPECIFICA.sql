-- Exclui APENAS as conversas (e dependências) desta lista — NÃO apaga public.clientes.
-- Empresa 4: apenas Saulo e Wagner Mendonça. Execute no Supabase SQL Editor.
-- Rode o SELECT de pré-visualização antes do DO.

DO $$
DECLARE
  v_company_id int := 4;

  -- Sem telefones neste caso (só nomes). Se precisar, preencha ex.: ARRAY['5534999999999']::text[]
  v_phones text[] := ARRAY[]::text[];

  -- trim + case-insensitive. "Saulo" pode coincidir com mais de um cliente na empresa.
  v_nomes text[] := ARRAY[
    'Wagner Mendonça',
    'Saulo'
  ];

  v_conversa_ids int[];
BEGIN
  SELECT array_agg(DISTINCT c.id)
  INTO v_conversa_ids
  FROM public.conversas c
  LEFT JOIN public.clientes cl ON cl.id = c.cliente_id AND cl.company_id = c.company_id
  WHERE c.company_id = v_company_id
    AND (
      (array_length(v_phones, 1) IS NOT NULL AND (
        c.telefone = ANY(v_phones)
        OR cl.telefone = ANY(v_phones)
        OR EXISTS (
          SELECT 1
          FROM unnest(v_phones) AS p(phone_raw)
          WHERE length(regexp_replace(phone_raw, '\D', '', 'g')) >= 8
            AND (
              c.telefone LIKE '%' || right(regexp_replace(phone_raw, '\D', '', 'g'), 8)
              OR cl.telefone LIKE '%' || right(regexp_replace(phone_raw, '\D', '', 'g'), 8)
            )
        )
      ))
      OR c.cliente_id IN (
        SELECT cl2.id
        FROM public.clientes cl2
        WHERE cl2.company_id = v_company_id
          AND lower(trim(cl2.nome)) IN (SELECT lower(trim(n)) FROM unnest(v_nomes) AS n)
      )
    );

  v_conversa_ids := COALESCE(v_conversa_ids, ARRAY[]::int[]);

  IF array_length(v_conversa_ids, 1) IS NULL THEN
    RAISE NOTICE 'Nenhuma conversa encontrada. Confira v_company_id e nomes.';
    RETURN;
  END IF;

  RAISE NOTICE 'IDs de conversas a excluir: %', v_conversa_ids;

  DELETE FROM public.avaliacoes_atendimento
  WHERE atendimento_id IN (SELECT id FROM public.atendimentos WHERE conversa_id = ANY(v_conversa_ids))
     OR conversa_id = ANY(v_conversa_ids);

  DELETE FROM public.mensagens_ocultas WHERE conversa_id = ANY(v_conversa_ids);
  DELETE FROM public.conversa_unreads WHERE conversa_id = ANY(v_conversa_ids);
  DELETE FROM public.atendimentos WHERE conversa_id = ANY(v_conversa_ids);
  DELETE FROM public.historico_atendimentos WHERE conversa_id = ANY(v_conversa_ids);
  DELETE FROM public.conversa_tags WHERE conversa_id = ANY(v_conversa_ids);
  DELETE FROM public.bot_logs WHERE conversa_id = ANY(v_conversa_ids);
  DELETE FROM public.mensagens WHERE conversa_id = ANY(v_conversa_ids);

  UPDATE public.conversas SET cliente_id = NULL WHERE id = ANY(v_conversa_ids);
  DELETE FROM public.conversas WHERE id = ANY(v_conversa_ids);

  RAISE NOTICE 'Concluído. Conversas removidas: % (clientes mantidos).', array_length(v_conversa_ids, 1);
END $$;

-- Pré-visualização (company_id 4, nomes Wagner Mendonça e Saulo):
/*
SELECT c.id, c.telefone, c.status_atendimento, cl.nome AS cliente_nome, cl.telefone AS cliente_telefone
FROM public.conversas c
LEFT JOIN public.clientes cl ON cl.id = c.cliente_id AND cl.company_id = c.company_id
WHERE c.company_id = 4
  AND c.cliente_id IN (
    SELECT cl2.id
    FROM public.clientes cl2
    WHERE cl2.company_id = 4
      AND lower(trim(cl2.nome)) IN (
        SELECT lower(trim(n)) FROM unnest(ARRAY['Wagner Mendonça', 'Saulo']) AS n
      )
  );
*/
