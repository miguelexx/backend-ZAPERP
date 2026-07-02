-- Diagnóstico: mensagens presas em status 'pending' ou 'sending' há mais de 15 minutos
-- (enviadas pelo CRM mas sem confirmação do WhatsApp)
-- Rodar periodicamente para detectar problemas de entrega.
--
-- Correção automática: scheduler pendingOutboundReconciliation (a cada 5 min)
-- consulta UltraMSG GET /messages?referenceId=crm-{mensagem.id} e atualiza status.

-- 1) Listar mensagens outbound presas
SELECT
  m.id,
  m.company_id,
  m.conversa_id,
  m.status,
  m.status_mensagem,
  m.whatsapp_id,
  m.criado_em,
  NOW() - m.criado_em AS tempo_presa,
  m.tipo,
  LEFT(m.texto, 80) AS texto_preview
FROM mensagens m
WHERE
  m.direcao = 'out'
  AND m.status IN ('pending', 'sending')
  AND m.status_mensagem IN ('pending', 'sending')
  AND m.criado_em < NOW() - INTERVAL '15 minutes'
  AND m.criado_em > NOW() - INTERVAL '7 days'
ORDER BY m.criado_em DESC
LIMIT 100;

-- 2) Contagem por empresa
SELECT
  company_id,
  COUNT(*) AS total_pendentes,
  MIN(criado_em) AS mais_antiga,
  MAX(criado_em) AS mais_recente
FROM mensagens
WHERE
  direcao = 'out'
  AND status IN ('pending', 'sending')
  AND criado_em < NOW() - INTERVAL '15 minutes'
  AND criado_em > NOW() - INTERVAL '7 days'
GROUP BY company_id
ORDER BY total_pendentes DESC;

-- 3) Correção manual opcional: marcar como 'erro' mensagens com >1h presa (NÃO EXECUTAR SEM ANÁLISE)
-- UPDATE mensagens
-- SET status = 'erro', status_mensagem = 'failed'
-- WHERE
--   direcao = 'out'
--   AND status IN ('pending', 'sending')
--   AND criado_em < NOW() - INTERVAL '1 hour'
--   AND company_id = <company_id>;
