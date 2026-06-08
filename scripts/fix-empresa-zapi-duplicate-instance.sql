-- Correcao segura de instance_id duplicado (company 8 inativa vs company 10 ativa).
-- Executar manualmente no Supabase SQL Editor apos revisao.
--
-- Problema: instance171535 em duas linhas; apenas uma deve estar ativa por instance_id.
-- Este script renomeia a linha INATIVA para evitar ambiguidade futura.

UPDATE public.empresa_zapi
SET instance_id = 'instance171535_legacy_c' || company_id::text,
    atualizado_em = now()
WHERE company_id = 8
  AND ativo = false
  AND instance_id = 'instance171535';

-- Validacao pos-update (deve retornar no maximo 1 linha ativa por instance_id):
-- SELECT instance_id, array_agg(company_id ORDER BY company_id) AS companies
-- FROM public.empresa_zapi
-- WHERE ativo = true
-- GROUP BY instance_id
-- HAVING count(*) > 1;
