-- FASE 2.1 - Evolui unicidade de mensagens para multi-instancia WhatsApp.
-- Seguro/aditivo para dados: nao apaga mensagens e aborta antes de trocar indices se houver duplicidade.
-- Para bases grandes em producao, preferir o script CONCURRENTLY em backend/supabase/production.

do $$
begin
  if exists (
    select 1
    from public.mensagens
    where whatsapp_instance_id is not null
      and whatsapp_id is not null
      and whatsapp_id <> ''
    group by company_id, whatsapp_instance_id, whatsapp_id
    having count(*) > 1
  ) then
    raise exception 'Precheck falhou: duplicidade em mensagens(company_id, whatsapp_instance_id, whatsapp_id)';
  end if;

  if exists (
    select 1
    from public.mensagens
    where whatsapp_instance_id is null
      and whatsapp_id is not null
      and whatsapp_id <> ''
    group by company_id, whatsapp_id
    having count(*) > 1
  ) then
    raise exception 'Precheck falhou: duplicidade legada em mensagens(company_id, whatsapp_id) com whatsapp_instance_id null';
  end if;
end $$;

create unique index if not exists idx_mensagens_company_instance_whatsapp_id_unique
  on public.mensagens (company_id, whatsapp_instance_id, whatsapp_id)
  where whatsapp_instance_id is not null
    and whatsapp_id is not null
    and whatsapp_id <> '';

create unique index if not exists idx_mensagens_company_whatsapp_id_legacy_null_unique
  on public.mensagens (company_id, whatsapp_id)
  where whatsapp_instance_id is null
    and whatsapp_id is not null
    and whatsapp_id <> '';

comment on index public.idx_mensagens_company_instance_whatsapp_id_unique is
  'Fase 2.1: idempotencia/status por whatsapp_id isolados por empresa e instancia.';

comment on index public.idx_mensagens_company_whatsapp_id_legacy_null_unique is
  'Fase 2.1: preserva idempotencia legada para mensagens sem whatsapp_instance_id.';

-- O indice antigo por (company_id, whatsapp_id) bloqueia o mesmo whatsapp_id em duas instancias
-- da mesma empresa. Remover somente depois dos parciais novos existirem.
drop index if exists public.idx_mensagens_company_whatsapp_id;
