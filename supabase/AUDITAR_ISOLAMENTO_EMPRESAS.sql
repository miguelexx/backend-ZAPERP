-- ============================================================
-- AUDITORIA E CORREÇÃO: Isolamento multi-tenant (clientes/conversas)
-- Cada empresa deve ver APENAS seus próprios clientes e conversas.
-- Execute no Supabase SQL Editor.
-- ============================================================

-- 1) AUDITORIA: Clientes com company_id incorreto ou conversas apontando para cliente de outra empresa
-- ============================================================

-- 1a) Conversas cujo cliente_id aponta para cliente de OUTRA empresa (inconsistência grave)
SELECT
  c.id AS conversa_id,
  c.company_id AS conversa_company_id,
  c.cliente_id,
  cl.company_id AS cliente_company_id,
  cl.telefone,
  cl.nome
FROM public.conversas c
JOIN public.clientes cl ON cl.id = c.cliente_id AND cl.company_id != c.company_id
WHERE c.cliente_id IS NOT NULL;

-- 1b) empresa_zapi: mesma instance_id em mais de uma empresa (configuração incorreta)
SELECT instance_id, array_agg(company_id ORDER BY company_id) AS company_ids, COUNT(*) AS qtd
FROM public.empresa_zapi
WHERE ativo = true
GROUP BY instance_id
HAVING COUNT(*) > 1;

-- 1c) Usuários: mesmo email em mais de uma empresa (exige company_id no login)
SELECT
  lower(trim(email)) AS email_normalizado,
  array_agg(company_id ORDER BY company_id) AS company_ids,
  COUNT(*) AS qtd
FROM public.usuarios
WHERE ativo = true
GROUP BY lower(trim(email))
HAVING COUNT(*) > 1;


-- 2) CORREÇÃO: Desvincular conversas de clientes de outra empresa
-- ATENÇÃO: Revise o resultado da auditoria 1a antes de executar.
-- ============================================================

-- 2a) Desvincula cliente_id em conversas onde o cliente pertence a outra empresa
-- (a conversa continua; o cliente_id fica null até ser recriado/vinculado corretamente)
/*
UPDATE public.conversas c
SET cliente_id = NULL
FROM public.clientes cl
WHERE c.cliente_id = cl.id
  AND c.company_id != cl.company_id;
*/


-- 3) VERIFICAÇÃO: Contagem por empresa (cada uma deve ter seus próprios registros)
-- ============================================================

SELECT
  e.id AS company_id,
  e.nome AS empresa_nome,
  (SELECT COUNT(*) FROM public.clientes WHERE company_id = e.id) AS total_clientes,
  (SELECT COUNT(*) FROM public.conversas WHERE company_id = e.id) AS total_conversas
FROM public.empresas e
ORDER BY e.id;


-- 4) CONSTRAINT sugerida (opcional): Garantir que conversa.cliente_id só aponte para cliente da mesma empresa
-- Requer uma FK composta ou trigger. Por ora, a auditoria acima identifica problemas.
-- ============================================================
