-- =====================================================================================
-- CONFIGURAÇÃO RÁPIDA DO CHATBOT (SEM FUNÇÕES CUSTOMIZADAS)
-- =====================================================================================
-- Este script configura o chatbot para todas as empresas usando apenas SQL básico

-- 1. Verificar empresas ativas
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

-- 2. Configurar chatbot para empresa ID 1 (exemplo)
-- Substitua o ID conforme necessário
INSERT INTO ia_config (company_id, config)
VALUES (1, '{
  "chatbot_triage": {
    "enabled": true,
    "welcomeMessage": "Olá! Seja bem-vindo(a) à nossa empresa.\\nPara direcionarmos seu atendimento, por favor escolha com qual setor deseja falar:",
    "invalidOptionMessage": "Opção inválida. Por favor, responda apenas com o número do setor desejado.",
    "confirmSelectionMessage": "Perfeito! Seu atendimento foi direcionado para o setor {{departamento}}. Em instantes nossa equipe dará continuidade.",
    "sendOnlyFirstTime": true,
    "fallbackToAI": false,
    "businessHoursOnly": false,
    "transferMode": "departamento",
    "tipo_distribuicao": "fila",
    "reopenMenuCommand": "0",
    "intervaloEnvioSegundos": 3,
    "foraHorarioEnabled": true,
    "horarioInicio": "09:00",
    "horarioFim": "18:00",
    "mensagemForaHorario": "Olá! Nosso horário de atendimento é de segunda a sexta, das 09h às 18h. Sua mensagem foi recebida e retornaremos no próximo dia útil. Obrigado!",
    "diasSemanaDesativados": [0, 6],
    "datasEspecificasFechadas": [],
    "enviarMensagemFinalizacao": false,
    "mensagemFinalizacao": "Atendimento finalizado com sucesso. Segue seu protocolo: {{protocolo}}.\\nPor favor, informe uma nota entre 0 e 10 para avaliar o atendimento prestado.",
    "options": [
      {
        "key": "1",
        "label": "Comercial",
        "departamento_id": 1,
        "active": true,
        "tag_id": null
      },
      {
        "key": "2",
        "label": "Suporte",
        "departamento_id": 2,
        "active": true,
        "tag_id": null
      },
      {
        "key": "3",
        "label": "Financeiro",
        "departamento_id": 3,
        "active": true,
        "tag_id": null
      },
      {
        "key": "4",
        "label": "Administrativo",
        "departamento_id": 4,
        "active": true,
        "tag_id": null
      }
    ]
  }
}'::jsonb)
ON CONFLICT (company_id) 
DO UPDATE SET 
  config = EXCLUDED.config,
  updated_at = NOW();

-- 3. Verificar se a configuração foi criada
SELECT 'CONFIGURAÇÃO CRIADA:' as info;
SELECT 
    company_id,
    config->'chatbot_triage'->>'enabled' as chatbot_enabled,
    jsonb_array_length(config->'chatbot_triage'->'options') as total_opcoes
FROM ia_config 
WHERE company_id = 1;

-- 4. Criar departamentos padrão se não existirem (para empresa 1)
INSERT INTO departamentos (company_id, nome) VALUES
    (1, 'Comercial'),
    (1, 'Suporte'),
    (1, 'Financeiro'),
    (1, 'Administrativo')
ON CONFLICT DO NOTHING;

-- 5. Verificar departamentos criados
SELECT 'DEPARTAMENTOS DA EMPRESA 1:' as info;
SELECT id, nome, company_id
FROM departamentos 
WHERE company_id = 1
ORDER BY id;

SELECT 'Configuração básica concluída para empresa ID 1!' as resultado;
SELECT 'Para configurar outras empresas, altere o company_id no script.' as dica;