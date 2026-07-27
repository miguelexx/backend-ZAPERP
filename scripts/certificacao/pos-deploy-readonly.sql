-- Auditoria pós-deploy ZapERP — somente leitura.
-- Execute no SQL Editor do Supabase de PRODUÇÃO com uma função autorizada.
-- Cada bloco é independente. Não contém INSERT, UPDATE, DELETE, DDL ou EXPLAIN ANALYZE.
-- Exporte os resultados sem colunas de texto, telefone, URL ou outros dados pessoais.

-- 1) Prova da migration de hardening.
select version, name, statements
from supabase_migrations.schema_migrations
where version = '20260727120000';

-- 2) RLS das tabelas internas. Esperado: rowsecurity = true em todas as linhas existentes.
select c.relname as table_name, c.relrowsecurity as rowsecurity
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in (
    'scheduler_locks',
    'atendimento_limits_company_configs',
    'atendimento_limits_user_configs',
    'atendimento_limits_consumptions',
    'atendimento_limits_history'
  )
order by c.relname;

-- 3) Privilégios diretos. Esperado: anon/authenticated sem privilégios;
-- service_role com privilégios nas tabelas existentes.
select grantee, table_name, string_agg(privilege_type, ', ' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in (
    'scheduler_locks',
    'atendimento_limits_company_configs',
    'atendimento_limits_user_configs',
    'atendimento_limits_consumptions',
    'atendimento_limits_history'
  )
  and grantee in ('anon', 'authenticated', 'service_role')
group by grantee, table_name
order by table_name, grantee;

-- 4) Privilégio da RPC interna. Esperado: apenas service_role com EXECUTE.
select routine_name, grantee, privilege_type
from information_schema.role_routine_grants
where routine_schema = 'public'
  and routine_name = 'atendimento_limits_validate_and_consume'
  and grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role')
order by grantee;

-- 5) Índices reais das tabelas críticas.
select tablename, indexname, indexdef
from pg_indexes
where schemaname = 'public'
  and tablename in ('mensagens', 'conversas')
order by tablename, indexname;

-- 6) Constraints reais das tabelas críticas.
select
  c.conrelid::regclass::text as table_name,
  c.conname as constraint_name,
  c.contype as constraint_type,
  pg_get_constraintdef(c.oid) as definition
from pg_constraint c
where c.connamespace = 'public'::regnamespace
  and c.conrelid in ('public.mensagens'::regclass, 'public.conversas'::regclass)
order by table_name, constraint_name;

-- 7) Duplicidade por WhatsApp ID, isolada por empresa e instância.
-- Esperado: zero linhas.
select company_id, whatsapp_instance_id, whatsapp_id, count(*) as total
from public.mensagens
where whatsapp_id is not null and btrim(whatsapp_id) <> ''
group by company_id, whatsapp_instance_id, whatsapp_id
having count(*) > 1
order by total desc;

-- 8) Duplicidade por client_temp_id.
-- Esperado: zero linhas.
select company_id, conversa_id, client_temp_id, count(*) as total
from public.mensagens
where client_temp_id is not null and btrim(client_temp_id) <> ''
group by company_id, conversa_id, client_temp_id
having count(*) > 1
order by total desc;

-- 9) Conversas abertas duplicadas para contato/instância.
-- Esperado: zero linhas.
select company_id, whatsapp_instance_id, telefone, count(*) as total
from public.conversas
where status_atendimento in ('aberta', 'em_atendimento')
  and telefone is not null
group by company_id, whatsapp_instance_id, telefone
having count(*) > 1
order by total desc;

-- 10) Integridade referencial e isolamento lógico. Todos os contadores esperados são zero.
select
  count(*) filter (where m.company_id is null) as mensagens_sem_empresa,
  count(*) filter (where m.conversa_id is null) as mensagens_sem_conversa_id,
  count(*) filter (where m.conversa_id is not null and c.id is null) as mensagens_com_conversa_inexistente,
  count(*) filter (
    where c.id is not null and m.company_id is distinct from c.company_id
  ) as mensagens_com_empresa_divergente
from public.mensagens m
left join public.conversas c on c.id = m.conversa_id;

-- 11) Pendências outbound por idade. Use este resultado para alertas.
select
  count(*) filter (where criado_em < now() - interval '5 minutes') as acima_5_min,
  count(*) filter (where criado_em < now() - interval '30 minutes') as acima_30_min,
  count(*) filter (where criado_em < now() - interval '60 minutes') as acima_60_min,
  min(criado_em) as pendencia_mais_antiga
from public.mensagens
where direcao = 'out'
  and lower(coalesce(nullif(status_mensagem, ''), nullif(status, ''), '')) in ('pending', 'sending');

-- 12) Distribuição agregada das pendências por empresa/instância, sem PII.
select
  company_id,
  whatsapp_instance_id,
  lower(coalesce(nullif(status_mensagem, ''), nullif(status, ''), '')) as status_atual,
  count(*) as total,
  min(criado_em) as mais_antiga,
  max(criado_em) as mais_recente
from public.mensagens
where direcao = 'out'
  and lower(coalesce(nullif(status_mensagem, ''), nullif(status, ''), '')) in ('pending', 'sending', 'erro', 'error', 'failed')
group by company_id, whatsapp_instance_id, status_atual
order by mais_antiga;

-- 13) Inconsistências de identificação e mídia em mensagens outbound recentes.
select
  count(*) filter (
    where direcao = 'out'
      and criado_em < now() - interval '30 minutes'
      and whatsapp_id is null
  ) as outbound_sem_whatsapp_id_30min,
  count(*) filter (
    where tipo in ('image', 'imagem', 'audio', 'ptt', 'voice', 'document', 'documento', 'video')
      and (url is null or btrim(url) = '')
  ) as midias_sem_url,
  count(*) filter (
    where whatsapp_instance_id is null
  ) as mensagens_sem_instancia
from public.mensagens
where criado_em >= now() - interval '24 hours';

-- 14) Locks e queries ativas há mais de 30 segundos.
select
  pid,
  usename,
  application_name,
  state,
  wait_event_type,
  wait_event,
  now() - query_start as running_for,
  left(regexp_replace(query, '\s+', ' ', 'g'), 200) as query_preview
from pg_stat_activity
where datname = current_database()
  and pid <> pg_backend_pid()
  and query_start < now() - interval '30 seconds'
order by query_start;

-- 15) Crescimento/tamanho das tabelas operacionais.
select
  relname as table_name,
  n_live_tup as estimated_rows,
  n_dead_tup as estimated_dead_rows,
  pg_size_pretty(pg_total_relation_size(relid)) as total_size,
  last_analyze,
  last_autoanalyze
from pg_stat_user_tables
where schemaname = 'public'
  and relname in (
    'mensagens',
    'conversas',
    'clientes',
    'webhook_logs',
    'scheduler_locks',
    'atendimento_limits_consumptions',
    'atendimento_limits_history'
  )
order by pg_total_relation_size(relid) desc;
