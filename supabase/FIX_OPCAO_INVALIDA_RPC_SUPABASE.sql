-- =====================================================
-- Corrigir RPC "opção inválida" no Supabase (limite de 2)
-- =====================================================
-- Use quando: a mensagem de opção inválida do chatbot não chega ao cliente
-- e você rodou no passado um script manual diferente deste repositório.
--
-- O backend chama: supabase.rpc('reserve_opcao_invalida_slot', {...})
-- Se a função no banco estiver errada, retorna sempre false, falha no INSERT
-- ou tiver outra assinatura, o fluxo pode parar antes de enviar o WhatsApp.
--
-- Passos: (1) rode só o bloco DIAGNÓSTICO; (2) depois rode CORREÇÃO.
-- =====================================================

-- ─────────────────────────────────────────────────────
-- 1) DIAGNÓSTICO (opcional — inspecionar o que existe hoje)
-- ─────────────────────────────────────────────────────

-- Todas as sobrecargas da função (deve existir UMA com 3 argumentos)
SELECT p.oid::regprocedure AS funcao_assinatura
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.proname = 'reserve_opcao_invalida_slot';

-- Corpo atual (compare com o bloco CORREÇÃO abaixo)
-- Usar p.oid — "oid" sozinho é ambíguo (pg_proc e pg_namespace têm oid)
SELECT pg_get_functiondef(p.oid) AS definicao
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.proname = 'reserve_opcao_invalida_slot'
LIMIT 1;

-- Quantos slots de opção inválida já foram “gastos” na conversa (máx 2)
-- Troque :company_id e :conversa_id pelos números reais
-- SELECT COUNT(*) FROM public.bot_logs
-- WHERE company_id = 1 AND conversa_id = 12345 AND tipo = 'opcao_invalida';

-- ─────────────────────────────────────────────────────
-- 2) REMOVER versões antigas / sobrecargas conflitantes
--    (Postgres trata (bigint,bigint) e (bigint,bigint,jsonb) como funções diferentes)
-- ─────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.reserve_opcao_invalida_slot(bigint, bigint);
DROP FUNCTION IF EXISTS public.reserve_opcao_invalida_slot(bigint, bigint, jsonb);
DROP FUNCTION IF EXISTS public.reserve_opcao_invalida_slot(integer, integer);
DROP FUNCTION IF EXISTS public.reserve_opcao_invalida_slot(integer, integer, jsonb);

-- ─────────────────────────────────────────────────────
-- 3) CORREÇÃO — função oficial (máx 2 por conversa)
--    SECURITY DEFINER + search_path fixo = INSERT em bot_logs não morre por RLS
-- ─────────────────────────────────────────────────────

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

COMMENT ON FUNCTION public.reserve_opcao_invalida_slot(bigint, bigint, jsonb) IS
  'Reserva atomicamente um slot para mensagem "opção inválida" (máx 2 por conversa). Retorna true se reservou, false se limite atingido.';

-- Permissões típicas no Supabase (backend com service_role)
GRANT EXECUTE ON FUNCTION public.reserve_opcao_invalida_slot(bigint, bigint, jsonb) TO postgres;
GRANT EXECUTE ON FUNCTION public.reserve_opcao_invalida_slot(bigint, bigint, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_opcao_invalida_slot(bigint, bigint, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_opcao_invalida_slot(bigint, bigint, jsonb) TO anon;

-- ─────────────────────────────────────────────────────
-- 4) OPCIONAL — liberar os 2 slots numa conversa de teste
--    (se já existiam 2 linhas opcao_invalida, a RPC retorna false e não envia)
-- ─────────────────────────────────────────────────────

-- DELETE FROM public.bot_logs
-- WHERE company_id = 1 AND conversa_id = 12345 AND tipo = 'opcao_invalida';

-- Ou limpar só opção inválida de TODAS as conversas (cuidado em produção):
-- DELETE FROM public.bot_logs WHERE tipo = 'opcao_invalida';
