-- =====================================================================================
-- GERENCIAMENTO INDIVIDUAL DO CHATBOT POR EMPRESA
-- =====================================================================================
-- Este script mostra como usar as funções reconfigure_company_chatbot() e 
-- toggle_company_chatbot() para gerenciar o chatbot de cada empresa individualmente.
-- 
-- IMPORTANTE: Execute primeiro o script AUTO_CONFIGURE_CHATBOT_ALL_COMPANIES.sql
-- para criar as funções necessárias.
-- =====================================================================================

-- 1. VERIFICAR STATUS ATUAL DE TODAS AS EMPRESAS
SELECT 'STATUS ATUAL DO CHATBOT POR EMPRESA:' as info;
SELECT 
    e.id as company_id,
    e.nome as empresa_nome,
    e.ativo as empresa_ativa,
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
-- EXEMPLOS DE USO DAS FUNÇÕES DE GERENCIAMENTO
-- =====================================================================================

-- 2. RECONFIGURAR CHATBOT DE UMA EMPRESA ESPECÍFICA
-- Use quando: departamentos foram alterados, configuração corrompida, ou reset necessário

-- Exemplo: Reconfigurar empresa ID 1
-- SELECT reconfigure_company_chatbot(1);

-- Exemplo: Reconfigurar empresa ID 2
-- SELECT reconfigure_company_chatbot(2);

-- Exemplo: Reconfigurar múltiplas empresas
-- SELECT reconfigure_company_chatbot(1) as resultado_empresa_1;
-- SELECT reconfigure_company_chatbot(2) as resultado_empresa_2;
-- SELECT reconfigure_company_chatbot(3) as resultado_empresa_3;

SELECT 'Para reconfigurar uma empresa, descomente e execute:' as dica;
SELECT 'SELECT reconfigure_company_chatbot(ID_DA_EMPRESA);' as exemplo;

-- =====================================================================================

-- 3. ATIVAR/DESATIVAR CHATBOT DE UMA EMPRESA
-- Use quando: manutenção, problemas temporários, ou controle de ativação

-- Exemplo: Ativar chatbot da empresa 1
-- SELECT toggle_company_chatbot(1, true);

-- Exemplo: Desativar chatbot da empresa 2
-- SELECT toggle_company_chatbot(2, false);

-- Exemplo: Ativar chatbot de múltiplas empresas
-- SELECT toggle_company_chatbot(1, true) as empresa_1;
-- SELECT toggle_company_chatbot(2, true) as empresa_2;
-- SELECT toggle_company_chatbot(3, true) as empresa_3;

SELECT 'Para ativar/desativar chatbot, descomente e execute:' as dica;
SELECT 'SELECT toggle_company_chatbot(ID_DA_EMPRESA, true/false);' as exemplo;

-- =====================================================================================
-- CENÁRIOS PRÁTICOS DE USO
-- =====================================================================================

-- 4. CENÁRIO: NOVA EMPRESA ADICIONADA
SELECT 'CENÁRIO 1: CONFIGURAR NOVA EMPRESA' as cenario;
SELECT 'Passos:' as info;
SELECT '1. Verificar se empresa existe: SELECT * FROM empresas WHERE id = X;' as passo_1;
SELECT '2. Configurar chatbot: SELECT reconfigure_company_chatbot(X);' as passo_2;
SELECT '3. Verificar resultado: Ver seção de verificação abaixo' as passo_3;

-- =====================================================================================

-- 5. CENÁRIO: EMPRESA ALTEROU DEPARTAMENTOS
SELECT 'CENÁRIO 2: DEPARTAMENTOS FORAM ALTERADOS' as cenario;
SELECT 'Exemplo para empresa ID 1:' as info;

-- Ver departamentos atuais da empresa 1
-- SELECT 'Departamentos atuais da empresa 1:' as info;
-- SELECT id, nome FROM departamentos WHERE company_id = 1 ORDER BY id;

-- Reconfigurar para refletir mudanças
-- SELECT reconfigure_company_chatbot(1);

-- Ver novas opções do menu
-- SELECT 'Novas opções do menu:' as info;
-- SELECT 
--     option->>'key' as opcao,
--     option->>'label' as setor,
--     option->>'departamento_id' as dept_id
-- FROM ia_config, 
--      jsonb_array_elements(config->'chatbot_triage'->'options') as option
-- WHERE company_id = 1;

-- =====================================================================================

-- 6. CENÁRIO: DESATIVAR TEMPORARIAMENTE PARA MANUTENÇÃO
SELECT 'CENÁRIO 3: MANUTENÇÃO TEMPORÁRIA' as cenario;
SELECT 'Exemplo para empresa ID 1:' as info;

-- Desativar chatbot para manutenção
-- SELECT toggle_company_chatbot(1, false);

-- Fazer alterações necessárias...
-- (Aqui você faria as alterações necessárias)

-- Reativar chatbot
-- SELECT toggle_company_chatbot(1, true);

-- =====================================================================================

-- 7. CENÁRIO: ATIVAÇÃO EM LOTE
SELECT 'CENÁRIO 4: ATIVAÇÃO EM LOTE' as cenario;

-- Script para ativar chatbot em todas as empresas ativas
-- Descomente para executar:

-- DO $$
-- DECLARE
--     empresa_record RECORD;
--     resultado TEXT;
-- BEGIN
--     FOR empresa_record IN 
--         SELECT id, nome FROM empresas WHERE ativo = true ORDER BY id
--     LOOP
--         SELECT toggle_company_chatbot(empresa_record.id, true) INTO resultado;
--         RAISE NOTICE 'Empresa %: %', empresa_record.nome, resultado;
--     END LOOP;
-- END $$;

-- =====================================================================================
-- VERIFICAÇÃO E MONITORAMENTO
-- =====================================================================================

-- 8. VERIFICAR CONFIGURAÇÃO DETALHADA DE UMA EMPRESA
SELECT 'VERIFICAÇÃO DETALHADA - Altere company_id conforme necessário:' as info;

-- Exemplo para empresa ID 1 (altere conforme necessário)
-- SELECT 
--     'EMPRESA 1 - CONFIGURAÇÃO DETALHADA:' as info,
--     config->'chatbot_triage'->>'enabled' as ativo,
--     config->'chatbot_triage'->>'welcomeMessage' as mensagem_boas_vindas,
--     config->'chatbot_triage'->>'horarioInicio' as horario_inicio,
--     config->'chatbot_triage'->>'horarioFim' as horario_fim,
--     config->'chatbot_triage'->>'foraHorarioEnabled' as fora_horario_ativo,
--     jsonb_array_length(config->'chatbot_triage'->'options') as total_opcoes
-- FROM ia_config 
-- WHERE company_id = 1;

-- =====================================================================================

-- 9. VERIFICAR OPÇÕES DO MENU DE UMA EMPRESA
SELECT 'VERIFICAR OPÇÕES DO MENU - Altere company_id conforme necessário:' as info;

-- Exemplo para empresa ID 1 (altere conforme necessário)
-- SELECT 
--     'EMPRESA 1 - OPÇÕES DO MENU:' as info,
--     option->>'key' as numero_opcao,
--     option->>'label' as nome_setor,
--     option->>'departamento_id' as id_departamento,
--     option->>'active' as opcao_ativa
-- FROM ia_config, 
--      jsonb_array_elements(config->'chatbot_triage'->'options') as option
-- WHERE company_id = 1
-- ORDER BY (option->>'key')::INTEGER;

-- =====================================================================================

-- 10. VERIFICAR LOGS DO CHATBOT DE UMA EMPRESA
SELECT 'VERIFICAR LOGS DO CHATBOT - Altere company_id conforme necessário:' as info;

-- Exemplo para empresa ID 1 (últimos 10 logs)
-- SELECT 
--     'EMPRESA 1 - ÚLTIMOS LOGS DO CHATBOT:' as info,
--     bl.tipo,
--     bl.criado_em,
--     bl.detalhes,
--     c.telefone,
--     c.nome_contato
-- FROM bot_logs bl
-- LEFT JOIN conversas c ON c.id = bl.conversa_id
-- WHERE bl.company_id = 1
-- ORDER BY bl.criado_em DESC
-- LIMIT 10;

-- =====================================================================================
-- COMANDOS RÁPIDOS PARA COPIAR E USAR
-- =====================================================================================

SELECT 'COMANDOS RÁPIDOS:' as info;
SELECT '
-- RECONFIGURAR EMPRESA (substitua X pelo ID):
SELECT reconfigure_company_chatbot(X);

-- ATIVAR CHATBOT (substitua X pelo ID):
SELECT toggle_company_chatbot(X, true);

-- DESATIVAR CHATBOT (substitua X pelo ID):
SELECT toggle_company_chatbot(X, false);

-- VER STATUS DE UMA EMPRESA (substitua X pelo ID):
SELECT 
    company_id,
    config->''chatbot_triage''->>''enabled'' as ativo,
    jsonb_array_length(config->''chatbot_triage''->''options'') as opcoes
FROM ia_config WHERE company_id = X;

-- VER DEPARTAMENTOS DE UMA EMPRESA (substitua X pelo ID):
SELECT id, nome FROM departamentos WHERE company_id = X ORDER BY id;
' as comandos;

-- =====================================================================================

SELECT 'GERENCIAMENTO INDIVIDUAL DO CHATBOT - GUIA CONCLUÍDO!' as resultado;
SELECT 'Descomente os comandos que deseja executar e altere os IDs conforme necessário.' as instrucao;
SELECT 'Lembre-se: sempre verifique o resultado após executar os comandos.' as dica_final;