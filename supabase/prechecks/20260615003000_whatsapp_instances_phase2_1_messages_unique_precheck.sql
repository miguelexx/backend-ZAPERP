-- FASE 2.1 - Precheck antes de evoluir unicidade de mensagens para multi-instancia.
-- Execute antes da migration 20260615003000_whatsapp_instances_phase2_1_messages_unique.sql.
-- A migration aborta se estes cenarios existirem; este arquivo deixa o diagnostico visivel.

-- 1) Duplicidades que impedem o novo unique por instancia.
select
  company_id,
  whatsapp_instance_id,
  whatsapp_id,
  count(*) as total,
  array_agg(id order by id) as mensagem_ids
from public.mensagens
where whatsapp_instance_id is not null
  and whatsapp_id is not null
  and whatsapp_id <> ''
group by company_id, whatsapp_instance_id, whatsapp_id
having count(*) > 1
order by total desc, company_id, whatsapp_instance_id, whatsapp_id;

-- 2) Duplicidades legadas que impedem manter protecao para registros sem instancia.
select
  company_id,
  whatsapp_id,
  count(*) as total,
  array_agg(id order by id) as mensagem_ids
from public.mensagens
where whatsapp_instance_id is null
  and whatsapp_id is not null
  and whatsapp_id <> ''
group by company_id, whatsapp_id
having count(*) > 1
order by total desc, company_id, whatsapp_id;

-- 3) Casos que passam a ser validos: mesmo whatsapp_id em instancias diferentes da mesma empresa.
-- Nao bloqueia a migration; serve para confirmar que o indice antigo (company_id, whatsapp_id)
-- precisa ser substituido pelos parciais novos.
select
  company_id,
  whatsapp_id,
  count(distinct whatsapp_instance_id) as instancias_distintas,
  array_agg(distinct whatsapp_instance_id order by whatsapp_instance_id) as whatsapp_instance_ids
from public.mensagens
where whatsapp_instance_id is not null
  and whatsapp_id is not null
  and whatsapp_id <> ''
group by company_id, whatsapp_id
having count(distinct whatsapp_instance_id) > 1
order by instancias_distintas desc, company_id, whatsapp_id;
