-- =====================================================================================
-- CONFIGURAÇÃO AUTOMÁTICA DO CHATBOT DE TRIAGEM PARA TODAS AS EMPRESAS
-- =====================================================================================
-- Este script configura automaticamente o chatbot de triagem para todas as empresas
-- do sistema, criando opções baseadas nos departamentos existentes de cada empresa.
-- 
-- Funcionalidades:
-- 1. Configura chatbot para todas as empresas ativas
-- 2. Cria opções baseadas nos departamentos existentes
-- 3. Permite personalização por empresa
-- 4. Reinicia processo quando conversa é reaberta
-- 5. Suporte a horário comercial e mensagens fora do horário
-- =====================================================================================

-- 1. VERIFICAR EMPRESAS ATIVAS NO SISTEMA
SELECT 'EMPRESAS ATIVAS NO SISTEMA:' as info;
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

-- 2. VERIFICAR CONFIGURAÇÕES EXISTENTES
SELECT 'CONFIGURAÇÕES DE CHATBOT EXISTENTES:' as info;
SELECT 
    ic.company_id,
    e.nome as empresa_nome,
    CASE 
        WHEN ic.config IS NULL THEN 'SEM_CONFIG'
        WHEN ic.config->'chatbot_triage' IS NULL THEN 'SEM_CHATBOT'
        WHEN (ic.config->'chatbot_triage'->>'enabled')::boolean = true THEN 'ATIVO'
        ELSE 'INATIVO'
    END as status_chatbot,
    COALESCE(jsonb_array_length(ic.config->'chatbot_triage'->'options'), 0) as total_opcoes
FROM empresas e
LEFT JOIN ia_config ic ON ic.company_id = e.id
WHERE e.ativo = true
ORDER BY e.id;

-- 3. FUNÇÃO PARA GERAR CONFIGURAÇÃO DINÂMICA DO CHATBOT
-- Esta função cria a configuração baseada nos departamentos de cada empresa
CREATE OR REPLACE FUNCTION generate_chatbot_config(p_company_id INTEGER)
RETURNS JSONB AS $$
DECLARE
    dept_record RECORD;
    options_array JSONB := '[]'::JSONB;
    option_counter INTEGER := 1;
    empresa_nome TEXT;
BEGIN
    -- Buscar nome da empresa
    SELECT nome INTO empresa_nome FROM empresas WHERE id = p_company_id;
    
    -- Gerar opções baseadas nos departamentos
    FOR dept_record IN 
        SELECT id, nome 
        FROM departamentos 
        WHERE company_id = p_company_id 
        ORDER BY id
    LOOP
        options_array := options_array || jsonb_build_object(
            'key', option_counter::text,
            'label', dept_record.nome,
            'departamento_id', dept_record.id,
            'active', true,
            'tag_id', null
        );
        option_counter := option_counter + 1;
    END LOOP;
    
    -- Se não há departamentos, criar departamentos padrão
    IF jsonb_array_length(options_array) = 0 THEN
        -- Inserir departamentos padrão
        INSERT INTO departamentos (company_id, nome) VALUES
            (p_company_id, 'Comercial'),
            (p_company_id, 'Suporte'),
            (p_company_id, 'Financeiro'),
            (p_company_id, 'Administrativo')
        ON CONFLICT DO NOTHING;
        
        -- Regenerar opções com os novos departamentos
        options_array := '[]'::JSONB;
        option_counter := 1;
        
        FOR dept_record IN 
            SELECT id, nome 
            FROM departamentos 
            WHERE company_id = p_company_id 
            ORDER BY id
        LOOP
            options_array := options_array || jsonb_build_object(
                'key', option_counter::text,
                'label', dept_record.nome,
                'departamento_id', dept_record.id,
                'active', true,
                'tag_id', null
            );
            option_counter := option_counter + 1;
        END LOOP;
    END IF;
    
    -- Retornar configuração completa
    RETURN jsonb_build_object(
        'chatbot_triage', jsonb_build_object(
            'enabled', true,
            'welcomeMessage', 'Olá! Seja bem-vindo(a) à ' || COALESCE(empresa_nome, 'nossa empresa') || '.' || E'\n' ||
                           'Para direcionarmos seu atendimento, por favor escolha com qual setor deseja falar:',
            'invalidOptionMessage', 'Opção inválida. Por favor, responda apenas com o número do setor desejado.',
            'confirmSelectionMessage', 'Perfeito! Seu atendimento foi direcionado para o setor {{departamento}}. Em instantes nossa equipe dará continuidade.',
            'sendOnlyFirstTime', true,
            'fallbackToAI', false,
            'businessHoursOnly', false,
            'transferMode', 'departamento',
            'tipo_distribuicao', 'fila',
            'reopenMenuCommand', '0',
            'intervaloEnvioSegundos', 3,
            'foraHorarioEnabled', true,
            'horarioInicio', '09:00',
            'horarioFim', '18:00',
            'mensagemForaHorario', 'Olá! Nosso horário de atendimento é de segunda a sexta, das 09h às 18h. Sua mensagem foi recebida e retornaremos no próximo dia útil. Obrigado!',
            'diasSemanaDesativados', ARRAY[0, 6], -- Domingo e Sábado
            'datasEspecificasFechadas', ARRAY[]::TEXT[],
            'enviarMensagemFinalizacao', false,
            'mensagemFinalizacao', 'Atendimento finalizado com sucesso. Segue seu protocolo: {{protocolo}}.' || E'\n' ||
                                 'Por favor, informe uma nota entre 0 e 10 para avaliar o atendimento prestado.',
            'options', options_array
        )
    );
END;
$$ LANGUAGE plpgsql;

-- 4. APLICAR CONFIGURAÇÃO PARA TODAS AS EMPRESAS ATIVAS
DO $$
DECLARE
    empresa_record RECORD;
    config_json JSONB;
BEGIN
    FOR empresa_record IN 
        SELECT id, nome FROM empresas WHERE ativo = true ORDER BY id
    LOOP
        -- Gerar configuração para a empresa
        config_json := generate_chatbot_config(empresa_record.id);
        
        -- Inserir ou atualizar configuração
        INSERT INTO ia_config (company_id, config)
        VALUES (empresa_record.id, config_json)
        ON CONFLICT (company_id) 
        DO UPDATE SET 
            config = EXCLUDED.config,
            updated_at = NOW();
            
        RAISE NOTICE 'Chatbot configurado para empresa ID % - %', empresa_record.id, empresa_record.nome;
    END LOOP;
END $$;

-- 5. VERIFICAR RESULTADO DA CONFIGURAÇÃO
SELECT 'RESULTADO DA CONFIGURAÇÃO:' as info;
SELECT 
    ic.company_id,
    e.nome as empresa_nome,
    ic.config->'chatbot_triage'->>'enabled' as chatbot_enabled,
    jsonb_array_length(ic.config->'chatbot_triage'->'options') as total_opcoes,
    ic.config->'chatbot_triage'->>'welcomeMessage' as welcome_message_preview
FROM ia_config ic
JOIN empresas e ON e.id = ic.company_id
WHERE e.ativo = true
  AND ic.config->'chatbot_triage' IS NOT NULL
ORDER BY ic.company_id;

-- 6. MOSTRAR OPÇÕES CONFIGURADAS POR EMPRESA
SELECT 'OPÇÕES DO MENU POR EMPRESA:' as info;
SELECT 
    ic.company_id,
    e.nome as empresa_nome,
    option->>'key' as opcao_numero,
    option->>'label' as setor_nome,
    option->>'departamento_id' as dept_id,
    option->>'active' as ativo
FROM ia_config ic
JOIN empresas e ON e.id = ic.company_id,
     jsonb_array_elements(ic.config->'chatbot_triage'->'options') as option
WHERE e.ativo = true
  AND ic.config->'chatbot_triage' IS NOT NULL
ORDER BY ic.company_id, (option->>'key')::INTEGER;

-- 7. LIMPAR LOGS ANTIGOS PARA PERMITIR TESTE COMPLETO (OPCIONAL)
-- Descomente as linhas abaixo se quiser limpar os logs para testar do zero
-- DELETE FROM bot_logs WHERE tipo IN ('menu_enviado', 'opcao_valida', 'opcao_invalida');
-- SELECT 'Logs do bot limpos para permitir teste completo' as info;

-- 8. CRIAR TRIGGER PARA AUTO-CONFIGURAÇÃO EM NOVAS EMPRESAS
CREATE OR REPLACE FUNCTION auto_configure_chatbot_on_new_company()
RETURNS TRIGGER AS $$
BEGIN
    -- Configurar chatbot automaticamente para nova empresa
    IF NEW.ativo = true THEN
        INSERT INTO ia_config (company_id, config)
        VALUES (NEW.id, generate_chatbot_config(NEW.id))
        ON CONFLICT (company_id) DO NOTHING;
        
        RAISE NOTICE 'Chatbot auto-configurado para nova empresa ID % - %', NEW.id, NEW.nome;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Criar trigger se não existir
DROP TRIGGER IF EXISTS trigger_auto_configure_chatbot ON empresas;
CREATE TRIGGER trigger_auto_configure_chatbot
    AFTER INSERT ON empresas
    FOR EACH ROW
    EXECUTE FUNCTION auto_configure_chatbot_on_new_company();

-- 9. FUNÇÃO PARA RECONFIGURAR CHATBOT DE UMA EMPRESA ESPECÍFICA
CREATE OR REPLACE FUNCTION reconfigure_company_chatbot(p_company_id INTEGER)
RETURNS TEXT AS $$
DECLARE
    config_json JSONB;
    empresa_nome TEXT;
BEGIN
    -- Verificar se empresa existe e está ativa
    SELECT nome INTO empresa_nome FROM empresas WHERE id = p_company_id AND ativo = true;
    
    IF empresa_nome IS NULL THEN
        RETURN 'Empresa não encontrada ou inativa: ' || p_company_id;
    END IF;
    
    -- Gerar nova configuração
    config_json := generate_chatbot_config(p_company_id);
    
    -- Atualizar configuração
    INSERT INTO ia_config (company_id, config)
    VALUES (p_company_id, config_json)
    ON CONFLICT (company_id) 
    DO UPDATE SET 
        config = EXCLUDED.config,
        updated_at = NOW();
    
    RETURN 'Chatbot reconfigurado com sucesso para: ' || empresa_nome;
END;
$$ LANGUAGE plpgsql;

-- 10. FUNÇÃO PARA ATIVAR/DESATIVAR CHATBOT DE UMA EMPRESA
CREATE OR REPLACE FUNCTION toggle_company_chatbot(p_company_id INTEGER, p_enabled BOOLEAN)
RETURNS TEXT AS $$
DECLARE
    empresa_nome TEXT;
BEGIN
    -- Verificar se empresa existe
    SELECT nome INTO empresa_nome FROM empresas WHERE id = p_company_id;
    
    IF empresa_nome IS NULL THEN
        RETURN 'Empresa não encontrada: ' || p_company_id;
    END IF;
    
    -- Atualizar status do chatbot
    UPDATE ia_config 
    SET config = jsonb_set(config, '{chatbot_triage,enabled}', to_jsonb(p_enabled)),
        updated_at = NOW()
    WHERE company_id = p_company_id;
    
    IF NOT FOUND THEN
        RETURN 'Configuração de chatbot não encontrada para empresa: ' || empresa_nome;
    END IF;
    
    RETURN 'Chatbot ' || CASE WHEN p_enabled THEN 'ativado' ELSE 'desativado' END || 
           ' para empresa: ' || empresa_nome;
END;
$$ LANGUAGE plpgsql;

-- EXEMPLOS DE USO:
-- 
-- Para reconfigurar chatbot de uma empresa específica:
-- SELECT reconfigure_company_chatbot(1);
-- 
-- Para ativar chatbot de uma empresa:
-- SELECT toggle_company_chatbot(1, true);
-- 
-- Para desativar chatbot de uma empresa:
-- SELECT toggle_company_chatbot(1, false);

SELECT 'CONFIGURAÇÃO AUTOMÁTICA DO CHATBOT CONCLUÍDA!' as resultado;
SELECT 'Todas as empresas ativas agora têm chatbot configurado automaticamente.' as info;
SELECT 'Use as funções reconfigure_company_chatbot() e toggle_company_chatbot() para gerenciar individualmente.' as dica;