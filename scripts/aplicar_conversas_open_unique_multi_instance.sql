-- Aplicar manualmente no Supabase SQL Editor (apos rodar o precheck).
-- Arquivo espelha: supabase/migrations/20260615120000_conversas_open_unique_multi_instance.sql

\i ../supabase/prechecks/20260615120000_conversas_open_unique_multi_instance_precheck.sql

-- Se as queries DUPLICIDADE_* acima retornarem linhas, resolva antes de continuar.

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

drop index if exists public.idx_conversas_company_telefone_open_unique;
