-- =====================================================================================
-- TESTE RÁPIDO DA CONFIGURAÇÃO DO CHATBOT
-- =====================================================================================
-- Execute este script para testar se a configuração automática está funcionando

-- 1. Verificar empresas ativas
SELECT 'EMPRESAS ATIVAS:' as info;
SELECT 
    e.id as company_id,
    e.nome as empresa_nome,
    e.ativo,
    COUNT(d.id) as total_departamentos
FROM empresas e
LEFT JOIN departamentos d ON d.company_id = e.id
WHERE e.ativo = true
GROUP BY e.id, e.nome, e.ativo
ORDER BY e.id;

-- 2. Verificar se há configurações de chatbot
SELECT 'CONFIGURAÇÕES EXISTENTES:' as info;
SELECT 
    ic.company_id,
    e.nome as empresa_nome,
    CASE 
        WHEN ic.config IS NULL THEN 'SEM_CONFIG'
        WHEN ic.config->'chatbot_triage' IS NULL THEN 'SEM_CHATBOT'
        WHEN (ic.config->'chatbot_triage'->>'enabled')::boolean = true THEN 'ATIVO'
        ELSE 'INATIVO'
    END as status_chatbot
FROM empresas e
LEFT JOIN ia_config ic ON ic.company_id = e.id
WHERE e.ativo = true
ORDER BY e.id;

-- 3. Verificar estrutura da tabela ia_config
SELECT 'ESTRUTURA DA TABELA IA_CONFIG:' as info;
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'ia_config' 
AND table_schema = 'public'
ORDER BY ordinal_position;

-- 4. Teste da função de geração de configuração (se existir)
-- Descomente a linha abaixo para testar com uma empresa específica
-- SELECT generate_chatbot_config(1);

SELECT 'Teste concluído! Se não houve erros, o sistema está funcionando.' as resultado;