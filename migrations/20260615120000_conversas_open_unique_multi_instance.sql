-- Conversas abertas/em atendimento: unicidade por instancia WhatsApp.
-- Substitui idx_conversas_company_telefone_open_unique (company_id + telefone apenas).
-- Nao apaga conversas, mensagens ou historico.

do $$
begin
  if exists (
    select 1
    from public.conversas
    where whatsapp_instance_id is not null
      and telefone is not null
      and btrim(telefone) <> ''
      and (tipo is null or tipo = 'cliente')
      and status_atendimento in ('aberta', 'em_atendimento')
    group by company_id, whatsapp_instance_id, telefone
    having count(*) > 1
  ) then
    raise exception 'Precheck falhou: duplicidade aberta em conversas(company_id, whatsapp_instance_id, telefone)';
  end if;

  if exists (
    select 1
    from public.conversas
    where whatsapp_instance_id is null
      and telefone is not null
      and btrim(telefone) <> ''
      and (tipo is null or tipo = 'cliente')
      and status_atendimento in ('aberta', 'em_atendimento')
    group by company_id, telefone
    having count(*) > 1
  ) then
    raise exception 'Precheck falhou: duplicidade aberta legada em conversas(company_id, telefone) com whatsapp_instance_id null';
  end if;
end $$;

create unique index if not exists idx_conversas_company_instance_telefone_open_unique
  on public.conversas (company_id, whatsapp_instance_id, telefone)
  where whatsapp_instance_id is not null
    and telefone is not null
    and btrim(telefone) <> ''
    and (tipo is null or tipo = 'cliente')
    and status_atendimento in ('aberta', 'em_atendimento');

create unique index if not exists idx_conversas_company_telefone_open_legacy_null_unique
  on public.conversas (company_id, telefone)
  where whatsapp_instance_id is null
    and telefone is not null
    and btrim(telefone) <> ''
    and (tipo is null or tipo = 'cliente')
    and status_atendimento in ('aberta', 'em_atendimento');

comment on index public.idx_conversas_company_instance_telefone_open_unique is
  'Multi-instancia: uma conversa aberta/em atendimento por (empresa, instancia WhatsApp, telefone).';

comment on index public.idx_conversas_company_telefone_open_legacy_null_unique is
  'Legado: uma conversa aberta/em atendimento por (empresa, telefone) quando whatsapp_instance_id e null.';

-- Remover indice antigo somente depois dos novos existirem.
drop index if exists public.idx_conversas_company_telefone_open_unique;
