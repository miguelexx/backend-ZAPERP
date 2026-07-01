-- =====================================================================================
-- EXEMPLOS PRÁTICOS - GERENCIAMENTO INDIVIDUAL DO CHATBOT
-- =====================================================================================
-- Scripts prontos para copiar, colar e usar no Supabase SQL Editor.
-- Substitua os IDs das empresas conforme necessário.
-- =====================================================================================

-- 📊 1. VER STATUS DE TODAS AS EMPRESAS
SELECT 
    e.id as company_id,
    e.nome as empresa_nome,
    CASE 
        WHEN ic.config IS NULL THEN '❌ SEM_CONFIG'
        WHEN ic.config->'chatbot_triage' IS NULL THEN '⚠️ SEM_CHATBOT'
        WHEN (ic.config->'chatbot_triage'->>'enabled')::boolean = true THEN '✅ ATIVO'
        ELSE '🔴 INATIVO'
    END as status_chatbot,
    COALESCE(jsonb_array_length(ic.config->'chatbot_triage'->'options'), 0) as total_opcoes,
    COUNT(d.id) as total_departamentos
FROM empresas e
LEFT JOIN ia_config ic ON ic.company_id = e.id
LEFT JOIN departamentos d ON d.company_id = e.id
WHERE e.ativo = true
GROUP BY e.id, e.nome, e.ativo, ic.config
ORDER BY e.id;

-- =====================================================================================

-- 🔧 2. RECONFIGURAR CHATBOT DE UMA EMPRESA
-- Substitua "1" pelo ID da empresa desejada
SELECT reconfigure_company_chatbot(1);

-- Para múltiplas empresas:
-- SELECT reconfigure_company_chatbot(1) as empresa_1;
-- SELECT reconfigure_company_chatbot(2) as empresa_2;
-- SELECT reconfigure_company_chatbot(3) as empresa_3;

-- =====================================================================================

-- ⚡ 3. ATIVAR CHATBOT DE UMA EMPRESA
-- Substitua "1" pelo ID da empresa desejada
SELECT toggle_company_chatbot(1, true);

-- Para múltiplas empresas:
-- SELECT toggle_company_chatbot(1, true) as empresa_1;
-- SELECT toggle_company_chatbot(2, true) as empresa_2;
-- SELECT toggle_company_chatbot(3, true) as empresa_3;

-- =====================================================================================

-- 🔴 4. DESATIVAR CHATBOT DE UMA EMPRESA
-- Substitua "1" pelo ID da empresa desejada
SELECT toggle_company_chatbot(1, false);

-- =====================================================================================

-- 🏢 5. VER DEPARTAMENTOS DE UMA EMPRESA
-- Substitua "1" pelo ID da empresa desejada
SELECT 
    'DEPARTAMENTOS DA EMPRESA 1:' as info,
    id, 
    nome,
    criado_em
FROM departamentos 
WHERE company_id = 1 
ORDER BY id;

-- =====================================================================================

-- 📋 6. VER CONFIGURAÇÃO DETALHADA DE UMA EMPRESA
-- Substitua "1" pelo ID da empresa desejada
SELECT 
    'CONFIGURAÇÃO DETALHADA DA EMPRESA 1:' as info,
    company_id,
    config->'chatbot_triage'->>'enabled' as chatbot_ativo,
    config->'chatbot_triage'->>'welcomeMessage' as mensagem_boas_vindas,
    config->'chatbot_triage'->>'horarioInicio' as horario_inicio,
    config->'chatbot_triage'->>'horarioFim' as horario_fim,
    config->'chatbot_triage'->>'foraHorarioEnabled' as fora_horario_ativo,
    config->'chatbot_triage'->>'reopenMenuCommand' as comando_reabrir,
    jsonb_array_length(config->'chatbot_triage'->'options') as total_opcoes
FROM ia_config 
WHERE company_id = 1;

-- =====================================================================================

-- 📱 7. VER OPÇÕES DO MENU DE UMA EMPRESA
-- Substitua "1" pelo ID da empresa desejada
SELECT 
    'OPÇÕES DO MENU DA EMPRESA 1:' as info,
    option->>'key' as numero_opcao,
    option->>'label' as nome_setor,
    option->>'departamento_id' as id_departamento,
    option->>'active' as opcao_ativa
FROM ia_config, 
     jsonb_array_elements(config->'chatbot_triage'->'options') as option
WHERE company_id = 1
ORDER BY (option->>'key')::INTEGER;

-- =====================================================================================

-- 📝 8. VER LOGS RECENTES DO CHATBOT DE UMA EMPRESA
-- Substitua "1" pelo ID da empresa desejada
SELECT 
    'LOGS RECENTES DO CHATBOT DA EMPRESA 1:' as info,
    bl.tipo,
    bl.criado_em,
    bl.detalhes->'opcao_key' as opcao_escolhida,
    bl.detalhes->'departamento_nome' as setor_escolhido,
    c.telefone,
    c.nome_contato
FROM bot_logs bl
LEFT JOIN conversas c ON c.id = bl.conversa_id
WHERE bl.company_id = 1
ORDER BY bl.criado_em DESC
LIMIT 10;

-- =====================================================================================

-- 🔄 9. ATIVAR CHATBOT EM TODAS AS EMPRESAS ATIVAS
DO $$
DECLARE
    empresa_record RECORD;
    resultado TEXT;
BEGIN
    RAISE NOTICE 'Iniciando ativação do chatbot para todas as empresas...';
    
    FOR empresa_record IN 
        SELECT id, nome FROM empresas WHERE ativo = true ORDER BY id
    LOOP
        SELECT toggle_company_chatbot(empresa_record.id, true) INTO resultado;
        RAISE NOTICE 'Empresa % (ID %): %', empresa_record.nome, empresa_record.id, resultado;
    END LOOP;
    
    RAISE NOTICE 'Ativação concluída!';
END $$;

-- =====================================================================================

-- 🔧 10. RECONFIGURAR CHATBOT EM TODAS AS EMPRESAS ATIVAS
-- CUIDADO: Isso vai reconfigurar TODAS as empresas
-- Descomente apenas se necessário:

-- DO $$
-- DECLARE
--     empresa_record RECORD;
--     resultado TEXT;
-- BEGIN
--     RAISE NOTICE 'Iniciando reconfiguração do chatbot para todas as empresas...';
--     
--     FOR empresa_record IN 
--         SELECT id, nome FROM empresas WHERE ativo = true ORDER BY id
--     LOOP
--         SELECT reconfigure_company_chatbot(empresa_record.id) INTO resultado;
--         RAISE NOTICE 'Empresa % (ID %): %', empresa_record.nome, empresa_record.id, resultado;
--     END LOOP;
--     
--     RAISE NOTICE 'Reconfiguração concluída!';
-- END $$;

-- =====================================================================================

-- 🧹 11. LIMPAR LOGS DO CHATBOT DE UMA EMPRESA (PARA TESTE)
-- Substitua "1" pelo ID da empresa desejada
-- CUIDADO: Isso remove o histórico de logs!

-- DELETE FROM bot_logs 
-- WHERE company_id = 1 
-- AND tipo IN ('menu_enviado', 'opcao_valida', 'opcao_invalida', 'menu_reenviado');

-- SELECT 'Logs do chatbot limpos para empresa 1' as resultado;

-- =====================================================================================

-- 📊 12. RELATÓRIO COMPLETO DE UMA EMPRESA
-- Substitua "1" pelo ID da empresa desejada

-- Informações da empresa
SELECT 'RELATÓRIO COMPLETO DA EMPRESA 1' as titulo;

SELECT 
    'DADOS DA EMPRESA:' as secao,
    id as empresa_id,
    nome as empresa_nome,
    ativo as empresa_ativa,
    criado_em as criada_em
FROM empresas 
WHERE id = 1;

-- Departamentos
SELECT 
    'DEPARTAMENTOS:' as secao,
    id as dept_id,
    nome as dept_nome,
    criado_em as criado_em
FROM departamentos 
WHERE company_id = 1 
ORDER BY id;

-- Status do chatbot
SELECT 
    'STATUS DO CHATBOT:' as secao,
    CASE 
        WHEN config->'chatbot_triage'->>'enabled' = 'true' THEN '✅ ATIVO'
        ELSE '🔴 INATIVO'
    END as status,
    jsonb_array_length(config->'chatbot_triage'->'options') as total_opcoes,
    config->'chatbot_triage'->>'horarioInicio' as horario_inicio,
    config->'chatbot_triage'->>'horarioFim' as horario_fim
FROM ia_config 
WHERE company_id = 1;

-- Estatísticas de uso (últimos 7 dias)
SELECT 
    'ESTATÍSTICAS (ÚLTIMOS 7 DIAS):' as secao,
    COUNT(*) as total_interacoes,
    COUNT(CASE WHEN tipo = 'menu_enviado' THEN 1 END) as menus_enviados,
    COUNT(CASE WHEN tipo = 'opcao_valida' THEN 1 END) as opcoes_validas,
    COUNT(CASE WHEN tipo = 'opcao_invalida' THEN 1 END) as opcoes_invalidas
FROM bot_logs 
WHERE company_id = 1 
AND criado_em >= NOW() - INTERVAL '7 days';

-- =====================================================================================

SELECT 'EXEMPLOS PRÁTICOS CONCLUÍDOS!' as resultado;
SELECT 'Copie e cole os comandos que deseja usar, alterando os IDs conforme necessário.' as instrucao;