-- Fase 2.x: tornar conversas compativeis com multiplas instancias WhatsApp por empresa.
-- Seguro/aditivo quanto a dados: nao apaga conversas, mensagens ou historico.

do $$
begin
  if exists (
    select 1
    from public.conversas
    where whatsapp_instance_id is not null
      and telefone is not null
      and btrim(telefone) <> ''
    group by company_id, whatsapp_instance_id, telefone
    having count(*) > 1
  ) then
    raise exception 'Precheck falhou: duplicidade em conversas(company_id, whatsapp_instance_id, telefone)';
  end if;

  if exists (
    select 1
    from public.conversas
    where whatsapp_instance_id is null
      and telefone is not null
      and btrim(telefone) <> ''
    group by company_id, telefone
    having count(*) > 1
  ) then
    raise exception 'Precheck falhou: duplicidade legada em conversas(company_id, telefone) com whatsapp_instance_id null';
  end if;

  if exists (
    select 1
    from public.conversas
    where whatsapp_instance_id is not null
      and chat_lid is not null
      and btrim(chat_lid) <> ''
    group by company_id, whatsapp_instance_id, chat_lid
    having count(*) > 1
  ) then
    raise exception 'Precheck falhou: duplicidade em conversas(company_id, whatsapp_instance_id, chat_lid)';
  end if;

  if exists (
    select 1
    from public.conversas
    where whatsapp_instance_id is null
      and chat_lid is not null
      and btrim(chat_lid) <> ''
    group by company_id, chat_lid
    having count(*) > 1
  ) then
    raise exception 'Precheck falhou: duplicidade legada em conversas(company_id, chat_lid) com whatsapp_instance_id null';
  end if;
end $$;

create unique index if not exists idx_conversas_company_instance_telefone_unique
  on public.conversas (company_id, whatsapp_instance_id, telefone)
  where whatsapp_instance_id is not null
    and telefone is not null
    and btrim(telefone) <> '';

create unique index if not exists idx_conversas_company_telefone_legacy_null_unique
  on public.conversas (company_id, telefone)
  where whatsapp_instance_id is null
    and telefone is not null
    and btrim(telefone) <> '';

create unique index if not exists idx_conversas_company_instance_chat_lid_unique
  on public.conversas (company_id, whatsapp_instance_id, chat_lid)
  where whatsapp_instance_id is not null
    and chat_lid is not null
    and btrim(chat_lid) <> '';

create unique index if not exists idx_conversas_company_chat_lid_legacy_null_unique
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

-- Remover/substituir unicidades antigas somente depois dos novos indices existirem.
alter table public.conversas drop constraint if exists idx_conversas_company_telefone;
drop index if exists public.idx_conversas_company_telefone;

alter table public.conversas drop constraint if exists idx_conversas_company_chat_lid;
drop index if exists public.idx_conversas_company_chat_lid;
