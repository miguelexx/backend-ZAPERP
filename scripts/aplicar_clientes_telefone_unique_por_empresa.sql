-- =====================================================================================
-- FIX: clientes.telefone estava com UNIQUE GLOBAL (sem company_id).
--
-- Sintoma: clicar em "Conversar" num contato cujo número já existe em OUTRA empresa
-- retornava 400 "Não foi possível salvar o contato" (Postgres 23505). O isolamento
-- multi-tenant exige que cada empresa tenha o seu próprio cliente com o mesmo número,
-- então a unicidade de telefone deve ser SEMPRE composta (company_id, telefone).
--
-- Esta migration:
--   1) Remove qualquer constraint/índice UNIQUE de coluna única em clientes(telefone).
--   2) Garante o índice composto por empresa idx_clientes_company_telefone_unique.
--
-- É idempotente e NÃO altera dados (apenas índices). Rode no SQL editor do Supabase.
-- Requer que NÃO existam duplicatas (company_id, telefone) — o app já evita via
-- getOrCreateCliente; se a criação do índice composto falhar por duplicata, rode antes
-- o diagnóstico no fim deste arquivo e deduplique.
-- =====================================================================================

-- 1) PRIMEIRO garante o índice único composto por empresa (o correto para multi-tenant).
--    Se falhar aqui por duplicata (company_id, telefone), a migration aborta ANTES de
--    remover qualquer proteção — rode o diagnóstico/dedup no fim do arquivo e repita.
CREATE UNIQUE INDEX IF NOT EXISTS idx_clientes_company_telefone_unique
  ON public.clientes (company_id, telefone);

-- 2) Só então dropar constraints UNIQUE de coluna única sobre `telefone` (nome pode variar).
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE t.relname = 'clientes'
      AND n.nspname = 'public'
      AND c.contype = 'u'
      AND array_length(c.conkey, 1) = 1
      AND (
        SELECT a.attname FROM pg_attribute a
        WHERE a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      ) = 'telefone'
  LOOP
    RAISE NOTICE 'Dropping UNIQUE constraint %I sobre clientes(telefone)', r.conname;
    EXECUTE format('ALTER TABLE public.clientes DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

-- 3) Dropar índices UNIQUE de coluna única sobre `telefone` que não sejam constraint.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT ic.relname AS idxname
    FROM pg_index i
    JOIN pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_class tc ON tc.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = tc.relnamespace
    WHERE tc.relname = 'clientes'
      AND n.nspname = 'public'
      AND i.indisunique
      AND i.indnkeyatts = 1
      AND ic.relname <> 'idx_clientes_company_telefone_unique'
      AND (
        SELECT a.attname FROM pg_attribute a
        WHERE a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
      ) = 'telefone'
  LOOP
    RAISE NOTICE 'Dropping UNIQUE index % sobre clientes(telefone)', r.idxname;
    EXECUTE format('DROP INDEX IF EXISTS public.%I', r.idxname);
  END LOOP;
END $$;

-- =====================================================================================
-- DIAGNÓSTICO (opcional) — rode ANTES para ver quais índices únicos existem em clientes:
--
--   SELECT ic.relname AS index_name, i.indisunique, i.indnkeyatts,
--          pg_get_indexdef(i.indexrelid) AS definition
--   FROM pg_index i
--   JOIN pg_class ic ON ic.oid = i.indexrelid
--   JOIN pg_class tc ON tc.oid = i.indrelid
--   JOIN pg_namespace n ON n.oid = tc.relnamespace
--   WHERE tc.relname = 'clientes' AND n.nspname = 'public' AND i.indisunique;
--
-- Se aparecer um index UNIQUE cuja definition seja só (telefone) — indnkeyatts=1 — esse é
-- o culpado (unicidade global, sem company_id). O correto é (company_id, telefone).
-- =====================================================================================
