-- Precheck: unicidade de conversas ABERTAS/EM_ATENDIMENTO por instancia WhatsApp.
-- Rode antes da migration 20260615120000_conversas_open_unique_multi_instance.sql.
-- Qualquer linha em DUPLICIDADE_* deve ser resolvida antes de aplicar.

-- 1) Bloqueia: duas conversas abertas no mesmo escopo multi-instancia (company + instance + telefone).
select
  'DUPLICIDADE_OPEN_INSTANCE_TELEFONE' as check_name,
  company_id,
  whatsapp_instance_id,
  telefone,
  count(*) as total,
  array_agg(id order by id) as conversa_ids,
  array_agg(status_atendimento order by id) as status_list
from public.conversas
where whatsapp_instance_id is not null
  and telefone is not null
  and btrim(telefone) <> ''
  and (tipo is null or tipo = 'cliente')
  and status_atendimento in ('aberta', 'em_atendimento')
group by company_id, whatsapp_instance_id, telefone
having count(*) > 1
order by total desc, company_id, whatsapp_instance_id, telefone;

-- 2) Bloqueia: duas conversas abertas no escopo legado (company + telefone, instance null).
select
  'DUPLICIDADE_OPEN_LEGADO_TELEFONE_NULL_INSTANCE' as check_name,
  company_id,
  telefone,
  count(*) as total,
  array_agg(id order by id) as conversa_ids,
  array_agg(status_atendimento order by id) as status_list
from public.conversas
where whatsapp_instance_id is null
  and telefone is not null
  and btrim(telefone) <> ''
  and (tipo is null or tipo = 'cliente')
  and status_atendimento in ('aberta', 'em_atendimento')
group by company_id, telefone
having count(*) > 1
order by total desc, company_id, telefone;

-- 3) Informativo: mesmo telefone aberto em instancias diferentes (passa a ser valido apos a migration).
select
  'INFORMATIVO_TELEFONE_ABERTO_EM_MULTIPLAS_INSTANCIAS' as check_name,
  company_id,
  telefone,
  count(*) as total_abertas,
  count(distinct whatsapp_instance_id) as instancias_distintas,
  array_agg(id order by id) as conversa_ids,
  array_agg(distinct whatsapp_instance_id order by whatsapp_instance_id) as whatsapp_instance_ids
from public.conversas
where whatsapp_instance_id is not null
  and telefone is not null
  and btrim(telefone) <> ''
  and (tipo is null or tipo = 'cliente')
  and status_atendimento in ('aberta', 'em_atendimento')
group by company_id, telefone
having count(distinct whatsapp_instance_id) > 1
order by company_id, telefone;

-- 4) Indice antigo ainda presente (sera substituido pela migration).
select
  'INDICE_ANTIGO_OPEN_UNIQUE' as check_name,
  indexname,
  indexdef
from pg_indexes
where schemaname = 'public'
  and tablename = 'conversas'
  and indexname = 'idx_conversas_company_telefone_open_unique';
