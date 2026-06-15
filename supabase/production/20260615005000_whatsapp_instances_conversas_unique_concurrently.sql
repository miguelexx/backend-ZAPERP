-- Opcional para producao com tabela conversas grande.
-- IMPORTANTE: CREATE INDEX CONCURRENTLY nao pode rodar dentro de transaction.
-- Rode o precheck 20260615005000_whatsapp_instances_conversas_unique_precheck.sql antes.

create unique index concurrently if not exists idx_conversas_company_instance_telefone_unique
  on public.conversas (company_id, whatsapp_instance_id, telefone)
  where whatsapp_instance_id is not null
    and telefone is not null
    and btrim(telefone) <> '';

create unique index concurrently if not exists idx_conversas_company_telefone_legacy_null_unique
  on public.conversas (company_id, telefone)
  where whatsapp_instance_id is null
    and telefone is not null
    and btrim(telefone) <> '';

create unique index concurrently if not exists idx_conversas_company_instance_chat_lid_unique
  on public.conversas (company_id, whatsapp_instance_id, chat_lid)
  where whatsapp_instance_id is not null
    and chat_lid is not null
    and btrim(chat_lid) <> '';

create unique index concurrently if not exists idx_conversas_company_chat_lid_legacy_null_unique
  on public.conversas (company_id, chat_lid)
  where whatsapp_instance_id is null
    and chat_lid is not null
    and btrim(chat_lid) <> '';

comment on index public.idx_conversas_company_instance_telefone_unique is
  'Multi-instancia: permite o mesmo telefone em instancias WhatsApp diferentes da mesma empresa.';

comment on index public.idx_conversas_company_telefone_legacy_null_unique is
  'Compatibilidade legada: uma conversa por telefone quando whatsapp_instance_id ainda e null.';

comment on index public.idx_conversas_company_instance_chat_lid_unique is
  'Multi-instancia: isola chat_lid por instancia WhatsApp.';

comment on index public.idx_conversas_company_chat_lid_legacy_null_unique is
  'Compatibilidade legada: uma conversa por chat_lid quando whatsapp_instance_id ainda e null.';

alter table public.conversas drop constraint if exists idx_conversas_company_telefone;
drop index if exists public.idx_conversas_company_telefone;

alter table public.conversas drop constraint if exists idx_conversas_company_chat_lid;
drop index if exists public.idx_conversas_company_chat_lid;
