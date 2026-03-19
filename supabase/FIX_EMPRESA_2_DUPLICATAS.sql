-- Correção específica para empresa 2: duplicatas e webhooks
-- Execute no Supabase SQL Editor

-- 1. Remover constraint que causa erro 23505
ALTER TABLE public.clientes 
  DROP CONSTRAINT IF EXISTS clientes_telefone_unique;

-- 2. Verificar e corrigir duplicatas na empresa 2
-- Encontrar clientes duplicados por telefone na empresa 2
WITH duplicados AS (
  SELECT telefone, company_id, array_agg(id ORDER BY id) as ids, count(*) as total
  FROM public.clientes 
  WHERE company_id = 2 AND telefone IS NOT NULL AND telefone != ''
  GROUP BY telefone, company_id 
  HAVING count(*) > 1
),
manter_primeiro AS (
  SELECT telefone, company_id, ids[1] as keep_id, ids[2:] as delete_ids
  FROM duplicados
)
-- Mover mensagens dos clientes duplicados para o primeiro
UPDATE public.conversas 
SET cliente_id = m.keep_id
FROM manter_primeiro m
WHERE conversas.company_id = 2 
  AND conversas.cliente_id = ANY(m.delete_ids);

-- Deletar clientes duplicados (manter só o primeiro)
WITH duplicados AS (
  SELECT telefone, company_id, array_agg(id ORDER BY id) as ids, count(*) as total
  FROM public.clientes 
  WHERE company_id = 2 AND telefone IS NOT NULL AND telefone != ''
  GROUP BY telefone, company_id 
  HAVING count(*) > 1
)
DELETE FROM public.clientes 
WHERE company_id = 2 
  AND id IN (
    SELECT unnest(ids[2:]) 
    FROM duplicados
  );

-- 3. Criar índice único correto (company_id + telefone)
DROP INDEX IF EXISTS idx_clientes_company_telefone_unique;
CREATE UNIQUE INDEX idx_clientes_company_telefone_unique 
  ON public.clientes (company_id, telefone) 
  WHERE telefone IS NOT NULL AND telefone != '';

-- 4. Verificar configuração empresa_zapi para empresa 2
SELECT 'Configuração empresa_zapi:' as info;
SELECT company_id, instance_id, 
       CASE WHEN instance_token IS NOT NULL THEN 'configurado' ELSE 'ausente' END as token_status,
       ativo 
FROM public.empresa_zapi 
WHERE company_id = 2 OR instance_id LIKE '%51534%';

-- 5. Se não existir, criar registro para empresa 2 (client_token vazio para UltraMsg)
INSERT INTO public.empresa_zapi (company_id, instance_id, instance_token, client_token, ativo)
VALUES (2, 'instance51534', 'r6ztawoqwcfhzrdc', '', true)
ON CONFLICT (company_id) DO UPDATE SET
  instance_id = EXCLUDED.instance_id,
  instance_token = EXCLUDED.instance_token,
  client_token = EXCLUDED.client_token,
  ativo = EXCLUDED.ativo;

-- 6. Verificar resultado
SELECT 'Resultado final:' as info;
SELECT company_id, instance_id, ativo 
FROM public.empresa_zapi 
WHERE company_id IN (1, 2);

SELECT 'Clientes empresa 2:' as info;
SELECT count(*) as total_clientes, 
       count(DISTINCT telefone) as telefones_unicos
FROM public.clientes 
WHERE company_id = 2;