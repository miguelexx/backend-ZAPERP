-- Precheck Fase 2.x: unicidade de conversas por instancia WhatsApp.
-- Rode antes da migration. Qualquer linha nas secoes DUPLICIDADE_* precisa ser resolvida antes.

-- 1) Bloqueia duplicidade no novo escopo multi-instancia por telefone.
select
  'DUPLICIDADE_INSTANCE_TELEFONE' as check_name,
  company_id,
  whatsapp_instance_id,
  telefone,
  count(*) as total,
  array_agg(id order by id) as conversa_ids
from public.conversas
where whatsapp_instance_id is not null
  and telefone is not null
  and btrim(telefone) <> ''
group by company_id, whatsapp_instance_id, telefone
having count(*) > 1
order by total desc, company_id, whatsapp_instance_id, telefone;

-- 2) Bloqueia duplicidade no escopo legado, preservado para conversas sem instancia.
select
  'DUPLICIDADE_LEGADO_TELEFONE_NULL_INSTANCE' as check_name,
  company_id,
  telefone,
  count(*) as total,
  array_agg(id order by id) as conversa_ids
from public.conversas
where whatsapp_instance_id is null
  and telefone is not null
  and btrim(telefone) <> ''
group by company_id, telefone
having count(*) > 1
order by total desc, company_id, telefone;

-- 3) Bloqueia duplicidade no novo escopo multi-instancia por chat_lid, quando existir.
select
  'DUPLICIDADE_INSTANCE_CHAT_LID' as check_name,
  company_id,
  whatsapp_instance_id,
  chat_lid,
  count(*) as total,
  array_agg(id order by id) as conversa_ids
from public.conversas
where whatsapp_instance_id is not null
  and chat_lid is not null
  and btrim(chat_lid) <> ''
group by company_id, whatsapp_instance_id, chat_lid
having count(*) > 1
order by total desc, company_id, whatsapp_instance_id, chat_lid;

-- 4) Bloqueia duplicidade no escopo legado de chat_lid.
select
  'DUPLICIDADE_LEGADO_CHAT_LID_NULL_INSTANCE' as check_name,
  company_id,
  chat_lid,
  count(*) as total,
  array_agg(id order by id) as conversa_ids
from public.conversas
where whatsapp_instance_id is null
  and chat_lid is not null
  and btrim(chat_lid) <> ''
group by company_id, chat_lid
having count(*) > 1
order by total desc, company_id, chat_lid;

-- 5) Informativo: estes casos eram bloqueados pelo indice antigo e passam a ser validos.
select
  'INFORMATIVO_TELEFONE_EM_MULTIPLAS_INSTANCIAS' as check_name,
  company_id,
  telefone,
  count(*) as total,
  count(distinct whatsapp_instance_id) as instancias_distintas,
  array_agg(id order by id) as conversa_ids,
  array_agg(distinct whatsapp_instance_id order by whatsapp_instance_id) as whatsapp_instance_ids
from public.conversas
where whatsapp_instance_id is not null
  and telefone is not null
  and btrim(telefone) <> ''
group by company_id, telefone
having count(distinct whatsapp_instance_id) > 1
order by company_id, telefone;
