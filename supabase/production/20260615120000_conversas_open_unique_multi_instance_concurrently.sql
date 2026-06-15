-- Producao (tabela grande): indices CONCURRENTLY para conversas abertas multi-instancia.
-- Rode o precheck 20260615120000_conversas_open_unique_multi_instance_precheck.sql antes.

create unique index concurrently if not exists idx_conversas_company_instance_telefone_open_unique
  on public.conversas (company_id, whatsapp_instance_id, telefone)
  where whatsapp_instance_id is not null
    and telefone is not null
    and btrim(telefone) <> ''
    and (tipo is null or tipo = 'cliente')
    and status_atendimento in ('aberta', 'em_atendimento');

create unique index concurrently if not exists idx_conversas_company_telefone_open_legacy_null_unique
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

drop index concurrently if exists public.idx_conversas_company_telefone_open_unique;
