-- ============================================================
-- CORREÇÃO: Isolamento multi-tenant — cada empresa só vê seus clientes
-- Execute APÓS rodar AUDITAR_ISOLAMENTO_EMPRESAS.sql e revisar os resultados.
-- ============================================================

BEGIN;

-- 1) Desvincula conversas de clientes que pertencem a OUTRA empresa
-- (cliente_id fica null; o sistema recriará/vinculou corretamente via webhook ou ao abrir conversa)
UPDATE public.conversas c
SET cliente_id = NULL
FROM public.clientes cl
WHERE c.cliente_id = cl.id
  AND c.company_id != cl.company_id;

-- 2) Verificar empresa_zapi: NÃO permitir mesma instance_id em duas empresas
-- Se houver duplicata, você precisa configurar instance_id diferente para cada empresa.
-- Lista as duplicatas para correção manual:
SELECT 'ATENÇÃO: instance_id duplicado - configure instance diferente por empresa:' AS aviso;
SELECT instance_id, company_id, ativo
FROM public.empresa_zapi
WHERE instance_id IN (
  SELECT instance_id FROM public.empresa_zapi WHERE ativo = true
  GROUP BY instance_id HAVING COUNT(*) > 1
)
ORDER BY instance_id, company_id;

COMMIT;
