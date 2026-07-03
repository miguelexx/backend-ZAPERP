-- ============================================================
-- Auditoria do fluxo de mensagens — SOMENTE SELECT (seguro)
-- Rodar no SQL Editor do Supabase de produção.
-- ============================================================

-- 1) IDs numéricos NOVOS em whatsapp_id (deve tender a ZERO após deploy de 2026-07-03)
SELECT count(*) AS ids_numericos_novos
FROM mensagens
WHERE whatsapp_id ~ '^\d{1,15}$'
  AND criado_em > '2026-07-03T00:00:00Z';

-- 2) Duplicadas por client_temp_id (deve ser ZERO — índice único garante)
SELECT company_id, conversa_id, client_temp_id, count(*) AS qtd
FROM mensagens
WHERE client_temp_id IS NOT NULL AND btrim(client_temp_id) <> ''
GROUP BY company_id, conversa_id, client_temp_id
HAVING count(*) > 1;

-- 3) Duplicadas por whatsapp_id na mesma empresa/instância (fonte de "ambíguo")
SELECT company_id, whatsapp_instance_id, whatsapp_id, count(*) AS qtd,
       array_agg(DISTINCT conversa_id) AS conversas
FROM mensagens
WHERE whatsapp_id IS NOT NULL AND btrim(whatsapp_id) <> ''
GROUP BY company_id, whatsapp_instance_id, whatsapp_id
HAVING count(*) > 1
ORDER BY qtd DESC
LIMIT 50;

-- 4) Duplicadas por provider_queue_id na mesma empresa/instância
SELECT company_id, whatsapp_instance_id, provider_queue_id, count(*) AS qtd
FROM mensagens
WHERE provider_queue_id IS NOT NULL
GROUP BY company_id, whatsapp_instance_id, provider_queue_id
HAVING count(*) > 1;

-- 5) Mensagens outbound presas em pending/sending há mais de 30 minutos
SELECT id, company_id, conversa_id, status, status_mensagem,
       whatsapp_id, provider_queue_id, criado_em
FROM mensagens
WHERE direcao = 'out'
  AND status IN ('pending', 'sending')
  AND criado_em < now() - interval '30 minutes'
ORDER BY criado_em DESC
LIMIT 100;

-- 6) Falhas recentes (últimas 24h)
SELECT id, company_id, conversa_id, tipo, status, criado_em
FROM mensagens
WHERE status IN ('erro', 'failed')
  AND criado_em > now() - interval '24 hours'
ORDER BY criado_em DESC
LIMIT 100;

-- 7) Integridade: mensagens órfãs (deve ser ZERO)
SELECT count(*) AS sem_conversa FROM mensagens WHERE conversa_id IS NULL;
SELECT count(*) AS sem_company  FROM mensagens WHERE company_id IS NULL;

-- 8) Conversas duplicadas por telefone/empresa/instância (risco de mensagem na conversa errada)
SELECT company_id, whatsapp_instance_id, telefone, count(*) AS qtd,
       array_agg(id ORDER BY id) AS conversa_ids
FROM conversas
WHERE telefone IS NOT NULL AND btrim(telefone) <> ''
  AND status_atendimento NOT IN ('finalizada')
GROUP BY company_id, whatsapp_instance_id, telefone
HAVING count(*) > 1
LIMIT 50;

-- 9) Clientes duplicados por telefone/empresa (deve ser ZERO — unique constraint)
SELECT company_id, telefone, count(*) AS qtd
FROM clientes
WHERE telefone IS NOT NULL
GROUP BY company_id, telefone
HAVING count(*) > 1;

-- 10) Índices críticos existentes (verificação)
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'mensagens'
  AND (indexdef ILIKE '%whatsapp_id%'
    OR indexdef ILIKE '%client_temp_id%'
    OR indexdef ILIKE '%provider_queue_id%');

-- 11) GRANTs das tabelas de push (diagnóstico do permission denied)
SELECT table_name, grantee, privilege_type
FROM information_schema.table_privileges
WHERE table_schema = 'public'
  AND table_name IN ('push_subscriptions', 'push_inbound_delivery_log', 'push_tokens')
ORDER BY table_name, grantee;

-- 12) Crescimento de tabelas (planejamento de retenção)
SELECT relname AS tabela,
       pg_size_pretty(pg_total_relation_size(relid)) AS tamanho_total,
       n_live_tup AS linhas_estimadas
FROM pg_stat_user_tables
WHERE relname IN ('mensagens', 'webhook_logs', 'conversas', 'clientes', 'push_inbound_delivery_log')
ORDER BY pg_total_relation_size(relid) DESC;
