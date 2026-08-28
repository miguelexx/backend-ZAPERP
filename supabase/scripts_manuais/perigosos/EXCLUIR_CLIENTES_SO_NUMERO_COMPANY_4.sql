-- =========================================================
-- Empresa company_id = 4
-- Exclui SOMENTE os clientes desta lista cujo nome é o próprio
-- telefone (cadastro "só número"). Conversas e mensagens ficam;
-- cliente_id da conversa vira NULL (igual DELETE /clientes/:id).
--
-- NÃO é migration. Rodar no SQL Editor do Supabase (postgres / service_role).
-- 1) Execute o bloco PREVIEW (SELECT) e confira id/nome/telefone.
-- 2) Se a lista estiver correta, execute o bloco EXCLUSÃO inteiro.
-- =========================================================

-- ---------- PREVIEW (só leitura) ----------
WITH informados(tel) AS (
  VALUES
    ('553498863795'),
    ('5517988103910'),
    ('553498768160'),
    ('553499743970'),
    ('5517996651104'),
    ('553492764555'),
    ('553496569265'),
    ('5517992334938'),
    ('553498807657'),
    ('553497746922'),
    ('553488555488'),
    ('553498741718'),
    ('553496690063'),
    ('553491777015'),
    ('553497670932'),
    ('553496680369'),
    ('553497730684'),
    ('553497783957'),
    ('553497744936'),
    ('553491645465'),
    ('553496357321'),
    ('553484244316'),
    ('553492455167'),
    ('553493048389'),
    ('553484342109'),
    ('553499948370'),
    ('553492351088'),
    ('553496611680'),
    ('553499958192'),
    ('553499970346'),
    ('553484227124'),
    ('553498983022'),
    ('553496764801'),
    ('553498743931'),
    ('553496890868'),
    ('553491192246'),
    ('553492293923'),
    ('553499944757'),
    ('553499279760'),
    ('553496845885'),
    ('553484278032')
),
variantes AS (
  SELECT DISTINCT v.tel
  FROM informados i
  CROSS JOIN LATERAL (
    SELECT i.tel
    UNION ALL
    SELECT CASE
      WHEN length(i.tel) = 13 AND substr(i.tel, 5, 1) = '9'
        THEN substr(i.tel, 1, 4) || substr(i.tel, 6)
      WHEN length(i.tel) = 12
        THEN substr(i.tel, 1, 4) || '9' || substr(i.tel, 5)
      ELSE NULL
    END
  ) v(tel)
  WHERE v.tel IS NOT NULL AND v.tel <> ''
)
SELECT
  cl.id,
  cl.company_id,
  cl.telefone,
  cl.nome,
  cl.pushname,
  CASE
    WHEN NULLIF(btrim(cl.nome), '') IS NULL THEN 'sem_nome'
    WHEN regexp_replace(cl.nome, '\D', '', 'g') = regexp_replace(coalesce(cl.telefone, ''), '\D', '', 'g') THEN 'nome_igual_telefone'
    WHEN regexp_replace(cl.nome, '\D', '', 'g') IN (SELECT v.tel FROM variantes v) THEN 'nome_igual_numero_da_lista'
    ELSE 'TEM_NOME_REAL_NAO_EXCLUIR'
  END AS classificacao
FROM public.clientes cl
WHERE cl.company_id = 4
  AND regexp_replace(coalesce(cl.telefone, ''), '\D', '', 'g') IN (SELECT v.tel FROM variantes v)
ORDER BY cl.id;

-- Números da lista sem cliente na empresa 4:
-- WITH ... (mesmo CTE) ...
-- SELECT i.tel FROM informados i
-- WHERE NOT EXISTS (
--   SELECT 1 FROM public.clientes cl
--   WHERE cl.company_id = 4
--     AND regexp_replace(coalesce(cl.telefone, ''), '\D', '', 'g') IN (SELECT v.tel FROM variantes v)
--     AND (
--       regexp_replace(coalesce(cl.telefone, ''), '\D', '', 'g') = i.tel
--       OR regexp_replace(coalesce(cl.telefone, ''), '\D', '', 'g') =
--          CASE WHEN length(i.tel) = 12 THEN substr(i.tel,1,4)||'9'||substr(i.tel,5)
--               WHEN length(i.tel)=13 AND substr(i.tel,5,1)='9' THEN substr(i.tel,1,4)||substr(i.tel,6)
--               ELSE i.tel END
--     )
-- );


-- ---------- EXCLUSÃO (rode só depois do PREVIEW) ----------
BEGIN;

CREATE TEMP TABLE tmp_alvos_c4 ON COMMIT DROP AS
WITH informados(tel) AS (
  VALUES
    ('553498863795'),
    ('5517988103910'),
    ('553498768160'),
    ('553499743970'),
    ('5517996651104'),
    ('553492764555'),
    ('553496569265'),
    ('5517992334938'),
    ('553498807657'),
    ('553497746922'),
    ('553488555488'),
    ('553498741718'),
    ('553496690063'),
    ('553491777015'),
    ('553497670932'),
    ('553496680369'),
    ('553497730684'),
    ('553497783957'),
    ('553497744936'),
    ('553491645465'),
    ('553496357321'),
    ('553484244316'),
    ('553492455167'),
    ('553493048389'),
    ('553484342109'),
    ('553499948370'),
    ('553492351088'),
    ('553496611680'),
    ('553499958192'),
    ('553499970346'),
    ('553484227124'),
    ('553498983022'),
    ('553496764801'),
    ('553498743931'),
    ('553496890868'),
    ('553491192246'),
    ('553492293923'),
    ('553499944757'),
    ('553499279760'),
    ('553496845885'),
    ('553484278032')
),
variantes AS (
  SELECT DISTINCT v.tel
  FROM informados i
  CROSS JOIN LATERAL (
    SELECT i.tel
    UNION ALL
    SELECT CASE
      WHEN length(i.tel) = 13 AND substr(i.tel, 5, 1) = '9'
        THEN substr(i.tel, 1, 4) || substr(i.tel, 6)
      WHEN length(i.tel) = 12
        THEN substr(i.tel, 1, 4) || '9' || substr(i.tel, 5)
      ELSE NULL
    END
  ) v(tel)
  WHERE v.tel IS NOT NULL AND v.tel <> ''
)
SELECT cl.id
FROM public.clientes cl
WHERE cl.company_id = 4
  AND regexp_replace(coalesce(cl.telefone, ''), '\D', '', 'g') IN (SELECT v.tel FROM variantes v)
  AND (
    NULLIF(btrim(cl.nome), '') IS NULL
    OR regexp_replace(cl.nome, '\D', '', 'g') = regexp_replace(coalesce(cl.telefone, ''), '\D', '', 'g')
    OR regexp_replace(cl.nome, '\D', '', 'g') IN (SELECT v.tel FROM variantes v)
  );

ALTER TABLE tmp_alvos_c4 ADD PRIMARY KEY (id);

DO $$
DECLARE n int;
BEGIN
  SELECT COUNT(*)::int INTO n FROM tmp_alvos_c4;
  RAISE NOTICE 'Clientes company_id=4 a excluir (nome = número): %', n;
END $$;

DELETE FROM public.avaliacoes_atendimento a
WHERE a.cliente_id IN (SELECT t.id FROM tmp_alvos_c4 t);

DELETE FROM public.contato_opt_out o
WHERE o.cliente_id IN (SELECT t.id FROM tmp_alvos_c4 t);

DELETE FROM public.contato_opt_in i
WHERE i.cliente_id IN (SELECT t.id FROM tmp_alvos_c4 t);

DELETE FROM public.cliente_tags ct
WHERE ct.cliente_id IN (SELECT t.id FROM tmp_alvos_c4 t);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'cliente_nomes_vinculados'
  ) THEN
    DELETE FROM public.cliente_nomes_vinculados nv
    WHERE nv.company_id = 4
      AND nv.cliente_id IN (SELECT t.id FROM tmp_alvos_c4 t);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'campanha_envios'
  ) THEN
    DELETE FROM public.campanha_envios e
    WHERE e.cliente_id IN (SELECT t.id FROM tmp_alvos_c4 t);
  END IF;
END $$;

UPDATE public.conversas c
SET cliente_id = NULL
WHERE c.company_id = 4
  AND c.cliente_id IN (SELECT t.id FROM tmp_alvos_c4 t);

DELETE FROM public.clientes cl
WHERE cl.company_id = 4
  AND cl.id IN (SELECT t.id FROM tmp_alvos_c4 t);

DO $$
DECLARE n int;
BEGIN
  SELECT COUNT(*)::int INTO n
  FROM public.clientes cl
  WHERE cl.company_id = 4
    AND cl.id IN (SELECT t.id FROM tmp_alvos_c4 t);
  IF n > 0 THEN
    RAISE WARNING 'Ainda restam % alvos. Verifique FK/RLS.', n;
  ELSE
    RAISE NOTICE 'OK: alvos da lista (nome = número) removidos na empresa 4. Conversas preservadas.';
  END IF;
END $$;

COMMIT;
