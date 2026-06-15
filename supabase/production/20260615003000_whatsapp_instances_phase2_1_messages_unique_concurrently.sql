-- FASE 2.1 - Variante para producao em bases grandes.
-- IMPORTANTE: executar fora de transaction, pois CREATE/DROP INDEX CONCURRENTLY nao pode rodar em BEGIN/COMMIT.
-- Rodar primeiro o precheck:
--   backend/supabase/prechecks/20260615003000_whatsapp_instances_phase2_1_messages_unique_precheck.sql
-- Se qualquer consulta de duplicidade retornar linhas, nao execute este script ate tratar os dados.

create unique index concurrently if not exists idx_mensagens_company_instance_whatsapp_id_unique
  on public.mensagens (company_id, whatsapp_instance_id, whatsapp_id)
  where whatsapp_instance_id is not null
    and whatsapp_id is not null
    and whatsapp_id <> '';

create unique index concurrently if not exists idx_mensagens_company_whatsapp_id_legacy_null_unique
  on public.mensagens (company_id, whatsapp_id)
  where whatsapp_instance_id is null
    and whatsapp_id is not null
    and whatsapp_id <> '';

comment on index public.idx_mensagens_company_instance_whatsapp_id_unique is
  'Fase 2.1: idempotencia/status por whatsapp_id isolados por empresa e instancia.';

comment on index public.idx_mensagens_company_whatsapp_id_legacy_null_unique is
  'Fase 2.1: preserva idempotencia legada para mensagens sem whatsapp_instance_id.';

-- Executar somente depois de confirmar que os dois indices parciais acima foram criados.
drop index concurrently if exists public.idx_mensagens_company_whatsapp_id;
