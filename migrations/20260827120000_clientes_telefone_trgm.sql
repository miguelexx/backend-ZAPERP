-- Acelera a busca de clientes por TELEFONE (ILIKE '%termo%') usada no GET /clientes
-- e nas RPCs buscar_clientes_por_nome_telefone / buscar_clientes_listagem.
--
-- Já existiam GIN trigram em clientes.nome e clientes.pushname (unaccent) desde
-- 20260810200000_search_unaccent.sql; faltava o de telefone. Sem ele, o wildcard
-- à esquerda ('%termo%') força seq scan da tabela clientes por empresa grande.
--
-- O índice único (company_id, telefone) é btree e NÃO cobre '%termo%'.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_clientes_telefone_trgm
  ON public.clientes USING gin (telefone gin_trgm_ops);

COMMENT ON INDEX public.idx_clientes_telefone_trgm IS
  'Acelera ILIKE %termo% em clientes.telefone (busca por fragmento de número).';
