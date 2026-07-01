-- Configuração do Chatbot de Triagem para Empresa 2
-- Execute no Supabase SQL Editor

-- 1. Verificar se já existe configuração
SELECT 'Configuração atual:' as info;
SELECT company_id, config->'chatbot_triage' as chatbot_config
FROM ia_config 
WHERE company_id = 2;

-- 2. Verificar departamentos disponíveis para a empresa 2
SELECT 'Departamentos disponíveis:' as info;
SELECT id, nome 
FROM departamentos 
WHERE company_id = 2
ORDER BY id;

-- 3. Inserir/atualizar configuração do chatbot
INSERT INTO ia_config (company_id, config)
VALUES (2, '{
  "chatbot_triage": {
    "enabled": true,
    "welcomeMessage": "Olá! Seja bem-vindo(a) à WM Sistemas.\\nPara direcionarmos seu atendimento, por favor escolha com qual setor deseja falar:",
    "invalidOptionMessage": "Opção inválida. Por favor, responda apenas com o número do setor desejado.",
    "confirmSelectionMessage": "Perfeito! Seu atendimento foi direcionado para o setor {{departamento}}. Em instantes nossa equipe dará continuidade.",
    "sendOnlyFirstTime": true,
    "fallbackToAI": false,
    "businessHoursOnly": false,
    "transferMode": "departamento",
    "tipo_distribuicao": "fila",
    "reopenMenuCommand": "0",
    "intervaloEnvioSegundos": 3,
    "foraHorarioEnabled": false,
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

-- 4. Verificar resultado final
SELECT 'Configuração final:' as info;
SELECT company_id, 
       config->'chatbot_triage'->>'enabled' as chatbot_enabled,
       config->'chatbot_triage'->>'welcomeMessage' as welcome_message,
       jsonb_array_length(config->'chatbot_triage'->'options') as total_opcoes
FROM ia_config 
WHERE company_id = 2;

-- 5. Mostrar opções configuradas
SELECT 'Opções do menu:' as info;
SELECT 
  option->>'key' as opcao,
  option->>'label' as setor,
  option->>'departamento_id' as dept_id,
  option->>'active' as ativo
FROM ia_config, 
     jsonb_array_elements(config->'chatbot_triage'->'options') as option
WHERE company_id = 2;

-- 6. Limpar logs antigos do bot para testar do zero (opcional)
-- DELETE FROM bot_logs WHERE company_id = 2 AND tipo = 'menu_enviado';

SELECT 'Configuração do chatbot concluída!' as resultado;