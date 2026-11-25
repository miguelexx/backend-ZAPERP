-- =============================================================================
-- REMOVER_EMPRESA_32_GJ_DUPLICADA.sql          *** APAGA DADOS ***
-- =============================================================================
-- Remove a empresa 32 ("GJ "), criada por engano em 24/11/2026 18:01.
--
-- CONTEXTO: a GJ de verdade e a empresa 19 -- era a "Maranata", foi renomeada
-- para GJ e ficou com a instancia Whapi AQUAMN-FJBTF (553434218097). A 32
-- nasceu na mesma hora e nunca foi usada: so tem os 4 departamentos que o
-- cadastro cria sozinho. Existirem duas empresas chamadas GJ confunde a
-- selecao de empresa e os relatorios.
--
-- *** NAO CONFUNDIR: a empresa 19 tambem se chama GJ e e a BOA. ***
-- Por isso este script NAO usa o nome como guarda principal: ele exige o id 32
-- E que a empresa esteja vazia. Se tiver qualquer usuario, instancia, conversa,
-- mensagem ou cliente, aborta sem apagar nada -- e sinal de que o id esta
-- errado ou de que a 32 passou a ser usada.
--
-- NAO e migration. Nao roda automaticamente. Rodar no SQL Editor do Supabase.
--
-- ORDEM: rode o bloco inteiro de uma vez. Qualquer erro = rollback de tudo.
-- Confira antes:
--   SELECT id, nome, ativo FROM public.empresas WHERE id IN (19, 32);
--   -- 19 = GJ (a boa, com instancia) | 32 = "GJ " (vazia, vai sair)
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '30s';
SET LOCAL row_security = off;

DO $$
DECLARE
  v_company integer := 32;
  v_boa     integer := 19;     -- a GJ de verdade: nunca pode ser tocada aqui
  r record;
  v_qtd bigint;
  v_lista text := '';
  v_apagados bigint := 0;
BEGIN
  IF v_company = v_boa THEN
    RAISE EXCEPTION 'Alvo igual a empresa boa (%). Nada foi apagado.', v_boa;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.empresas WHERE id = v_company) THEN
    RAISE EXCEPTION 'Empresa % nao existe. Nada foi apagado.', v_company;
  END IF;

  PERFORM 1 FROM public.empresas WHERE id = v_company FOR UPDATE;

  -- A empresa 19 tem que continuar existindo e com instancia: se nao tiver,
  -- alguem mexeu no lugar errado e este script nao deve seguir.
  IF NOT EXISTS (
    SELECT 1 FROM public.whatsapp_instances WHERE company_id = v_boa
  ) THEN
    RAISE EXCEPTION
      'Empresa % (a GJ boa) esta sem instancia -- confira o cenario antes. Nada foi apagado.', v_boa;
  END IF;

  -- Varre TODA tabela de public com company_id/empresa_id. So `departamentos`
  -- pode ter linha; qualquer outra coisa aborta.
  FOR r IN
    SELECT
      c.table_schema,
      c.table_name,
      CASE WHEN bool_or(c.column_name = 'company_id') THEN 'company_id' ELSE 'empresa_id' END AS tenant_col
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema
     AND t.table_name = c.table_name
     AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public'
      AND c.column_name IN ('company_id', 'empresa_id')
      AND c.table_name <> 'empresas'
    GROUP BY c.table_schema, c.table_name
    ORDER BY c.table_name
  LOOP
    EXECUTE format('SELECT count(*) FROM %I.%I WHERE %I = $1',
                   r.table_schema, r.table_name, r.tenant_col)
      INTO v_qtd USING v_company;

    IF v_qtd > 0 AND r.table_name <> 'departamentos' THEN
      v_lista := v_lista || r.table_name || '=' || v_qtd || ' ';
    END IF;
  END LOOP;

  IF btrim(v_lista) <> '' THEN
    RAISE EXCEPTION
      'Empresa % NAO esta vazia (%). Esperado so departamentos. Nada foi apagado.',
      v_company, btrim(v_lista);
  END IF;

  -- Vinculos de usuario a departamento da empresa (nao deve existir, mas o
  -- delete abaixo falharia por FK se existisse).
  DELETE FROM public.usuario_departamentos
  WHERE departamento_id IN (
    SELECT id FROM public.departamentos WHERE company_id = v_company
  );

  DELETE FROM public.departamentos WHERE company_id = v_company;
  GET DIAGNOSTICS v_apagados = ROW_COUNT;
  RAISE NOTICE 'departamentos apagados: %', v_apagados;

  DELETE FROM public.empresas WHERE id = v_company;

  IF EXISTS (SELECT 1 FROM public.empresas WHERE id = v_company) THEN
    RAISE EXCEPTION 'Empresa % ainda existe. Nada foi gravado.', v_company;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.empresas WHERE id = v_boa) THEN
    RAISE EXCEPTION 'Empresa % sumiu -- rollback. Nada foi gravado.', v_boa;
  END IF;

  RAISE NOTICE 'OK: empresa % removida. A GJ que ficou e a %.', v_company, v_boa;
END
$$;

SELECT id, nome, ativo,
       (SELECT count(*) FROM public.whatsapp_instances i WHERE i.company_id = e.id) AS instancias,
       (SELECT count(*) FROM public.usuarios u WHERE u.company_id = e.id) AS usuarios
FROM public.empresas e
WHERE btrim(e.nome) ILIKE 'GJ';

COMMIT;
