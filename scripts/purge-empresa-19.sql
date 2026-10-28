-- Purge TOTAL da empresa 19 (Maranata).
-- Rode o arquivo INTEIRO, da primeira linha ate o COMMIT.
-- Nao selecione so o DELETE: um BEGIN solto antes dele da erro de sintaxe.
--
-- Apaga usuarios, mensagens, conversas, clientes, departamentos, instancias
-- e a propria empresa. Nao apaga midia no R2. Nao mexe em outra empresa.
-- Se der erro, nada fica gravado. Se a transacao continuar aberta: ROLLBACK;

BEGIN;

SET LOCAL statement_timeout = '60min';
SET LOCAL lock_timeout = '30s';
SET LOCAL row_security = off;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.empresas
    WHERE id = 19
      AND btrim(nome) ILIKE 'Maranata'
  ) THEN
    RAISE EXCEPTION 'Empresa 19 nao se chama Maranata. Nada foi apagado.';
  END IF;
END
$$;

-- Tabelas sem company_id. Fora do bloco, para o editor nao partir o DELETE.
DELETE FROM public.historico_atendimentos
WHERE conversa_id IN (
  SELECT id FROM public.conversas WHERE company_id = 19
);

UPDATE public.historico_atendimentos
SET usuario_id = NULL
WHERE usuario_id IN (
  SELECT id FROM public.usuarios WHERE company_id = 19
);

DELETE FROM public.internal_conversation_reads
WHERE conversation_id IN (
  SELECT id FROM public.internal_conversations WHERE company_id = 19
)
OR user_id IN (
  SELECT id FROM public.usuarios WHERE company_id = 19
);

DO $$
DECLARE
  v_company integer := 19;
  v_nome text := 'Maranata';
  r record;
  fk record;
  v_pass integer;
  v_progress boolean;
  v_blocked integer;
  v_deleted bigint;
  v_restam bigint;
  v_constraint text;
  v_detail text;
  v_msg text;
  v_child_schema text;
  v_child_table text;
  v_child_col text;
  v_parent_col text;
  v_child_tenant text;
  v_nullable boolean;
  v_nkeys integer;
  v_sql text;
  v_lista text;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.empresas
    WHERE id = v_company
      AND btrim(nome) ILIKE v_nome
  ) THEN
    RAISE EXCEPTION 'Empresa % nao se chama %. Nada foi apagado.', v_company, v_nome;
  END IF;

  PERFORM 1
  FROM public.empresas
  WHERE id = v_company
  FOR UPDATE;

  UPDATE public.empresas
  SET ativo = false
  WHERE id = v_company;

  FOR v_pass IN 1..40 LOOP
    v_progress := false;
    v_blocked := 0;

    FOR r IN
      SELECT
        c.table_schema,
        c.table_name,
        CASE
          WHEN bool_or(c.column_name = 'company_id') THEN 'company_id'
          ELSE 'empresa_id'
        END AS tenant_col
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
      v_sql := format(
        'DELETE FROM %I.%I WHERE %I = $1',
        r.table_schema, r.table_name, r.tenant_col
      );

      BEGIN
        FOR fk IN
          SELECT ca.attname AS col
          FROM pg_constraint con
          JOIN pg_class rel ON rel.oid = con.conrelid
          JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
          JOIN pg_attribute ca
            ON ca.attrelid = con.conrelid
           AND ca.attnum = con.conkey[1]
          WHERE con.contype = 'f'
            AND con.conrelid = con.confrelid
            AND nsp.nspname = r.table_schema
            AND rel.relname = r.table_name
            AND cardinality(con.conkey) = 1
            AND NOT ca.attnotnull
        LOOP
          EXECUTE format(
            'UPDATE %I.%I SET %I = NULL WHERE %I = $1 AND %I IS NOT NULL',
            r.table_schema, r.table_name, fk.col, r.tenant_col, fk.col
          ) USING v_company;
        END LOOP;

        EXECUTE v_sql USING v_company;
        GET DIAGNOSTICS v_deleted = ROW_COUNT;
        IF v_deleted > 0 THEN
          v_progress := true;
          RAISE NOTICE 'apagados % em %', v_deleted, r.table_name;
        END IF;
      EXCEPTION
        WHEN foreign_key_violation THEN
          v_blocked := v_blocked + 1;
          GET STACKED DIAGNOSTICS
            v_constraint = CONSTRAINT_NAME,
            v_detail = PG_EXCEPTION_DETAIL,
            v_msg = MESSAGE_TEXT;

          SELECT
            nsp.nspname,
            child.relname,
            ca.attname,
            pa.attname,
            NOT ca.attnotnull,
            cardinality(con.conkey)
          INTO
            v_child_schema,
            v_child_table,
            v_child_col,
            v_parent_col,
            v_nullable,
            v_nkeys
          FROM pg_constraint con
          JOIN pg_class child ON child.oid = con.conrelid
          JOIN pg_namespace nsp ON nsp.oid = child.relnamespace
          JOIN pg_class parent ON parent.oid = con.confrelid
          JOIN pg_namespace pn ON pn.oid = parent.relnamespace
          JOIN pg_attribute ca
            ON ca.attrelid = con.conrelid
           AND ca.attnum = con.conkey[1]
          JOIN pg_attribute pa
            ON pa.attrelid = con.confrelid
           AND pa.attnum = con.confkey[1]
          WHERE con.conname = v_constraint
            AND con.contype = 'f'
            AND pn.nspname = r.table_schema
            AND parent.relname = r.table_name
          LIMIT 1;

          IF v_child_table IS NULL OR COALESCE(v_nkeys, 1) > 1 THEN
            RAISE EXCEPTION
              'FK % bloqueou %.%. Nada foi gravado.',
              COALESCE(v_constraint, '?'), r.table_schema, r.table_name;
          END IF;

          SELECT c.column_name
          INTO v_child_tenant
          FROM information_schema.columns c
          WHERE c.table_schema = v_child_schema
            AND c.table_name = v_child_table
            AND c.column_name IN ('company_id', 'empresa_id')
          ORDER BY CASE c.column_name WHEN 'company_id' THEN 1 ELSE 2 END
          LIMIT 1;

          IF v_child_schema = r.table_schema AND v_child_table = r.table_name THEN
            NULL;
          ELSIF v_child_tenant IS NULL THEN
            BEGIN
              EXECUTE format(
                'DELETE FROM %I.%I WHERE %I IN (SELECT %I FROM %I.%I WHERE %I = $1)',
                v_child_schema, v_child_table, v_child_col,
                v_parent_col, r.table_schema, r.table_name, r.tenant_col
              ) USING v_company;
              GET DIAGNOSTICS v_deleted = ROW_COUNT;
              IF v_deleted > 0 THEN
                v_progress := true;
                RAISE NOTICE 'apagados % em %', v_deleted, v_child_table;
              END IF;
            EXCEPTION
              WHEN foreign_key_violation THEN
                NULL;
            END;
          ELSIF v_nullable THEN
            BEGIN
              EXECUTE format(
                'UPDATE %I.%I SET %I = NULL WHERE %I IN (SELECT %I FROM %I.%I WHERE %I = $1) AND %I IS DISTINCT FROM $1',
                v_child_schema, v_child_table, v_child_col, v_child_col,
                v_parent_col, r.table_schema, r.table_name, r.tenant_col,
                v_child_tenant
              ) USING v_company;
              GET DIAGNOSTICS v_deleted = ROW_COUNT;
              IF v_deleted > 0 THEN
                v_progress := true;
                RAISE NOTICE 'anulado % em %.%', v_deleted, v_child_table, v_child_col;
              END IF;
            EXCEPTION
              WHEN foreign_key_violation THEN
                NULL;
            END;
          ELSE
            RAISE NOTICE 'bloqueio %: %', v_constraint, COALESCE(v_detail, v_msg);
          END IF;
      END;
    END LOOP;

    EXIT WHEN v_blocked = 0;

    IF NOT v_progress THEN
      RAISE EXCEPTION
        'Purge da empresa % travou em chave estrangeira. Nada foi gravado.',
        v_company;
    END IF;
  END LOOP;

  v_lista := '';
  FOR r IN
    SELECT
      c.table_schema,
      c.table_name,
      CASE
        WHEN bool_or(c.column_name = 'company_id') THEN 'company_id'
        ELSE 'empresa_id'
      END AS tenant_col
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema
     AND t.table_name = c.table_name
     AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public'
      AND c.column_name IN ('company_id', 'empresa_id')
      AND c.table_name <> 'empresas'
    GROUP BY c.table_schema, c.table_name
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM %I.%I WHERE %I = $1',
      r.table_schema, r.table_name, r.tenant_col
    ) INTO v_restam USING v_company;
    IF v_restam > 0 THEN
      v_lista := v_lista || r.table_name || '=' || v_restam || ' ';
    END IF;
  END LOOP;

  IF btrim(v_lista) <> '' THEN
    RAISE EXCEPTION 'Ainda restam linhas da empresa %: %. Nada foi gravado.', v_company, v_lista;
  END IF;

  DELETE FROM public.empresas
  WHERE id = v_company
    AND btrim(nome) ILIKE v_nome;

  IF EXISTS (SELECT 1 FROM public.empresas WHERE id = v_company) THEN
    RAISE EXCEPTION 'Empresa % ainda existe. Nada foi gravado.', v_company;
  END IF;
END
$$;

SELECT
  (SELECT count(*) FROM public.empresas WHERE id = 19) AS empresa,
  (SELECT count(*) FROM public.usuarios WHERE company_id = 19) AS usuarios,
  (SELECT count(*) FROM public.mensagens WHERE company_id = 19) AS mensagens,
  (SELECT count(*) FROM public.conversas WHERE company_id = 19) AS conversas,
  (SELECT count(*) FROM public.clientes WHERE company_id = 19) AS clientes;

COMMIT;
