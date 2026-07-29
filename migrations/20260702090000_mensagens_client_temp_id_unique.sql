-- Persist durable idempotency key for manual outbound messages.
-- Prevents duplicate sends when the frontend retries after timeout, process restart,
-- or another backend worker receives the same request.

alter table public.mensagens
  add column if not exists client_temp_id text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'mensagens_client_temp_id_len_chk'
      and conrelid = 'public.mensagens'::regclass
  ) then
    alter table public.mensagens
      add constraint mensagens_client_temp_id_len_chk
      check (client_temp_id is null or char_length(client_temp_id) <= 64)
      not valid;
  end if;
end $$;

alter table public.mensagens
  validate constraint mensagens_client_temp_id_len_chk;

create unique index if not exists idx_mensagens_client_temp_id_unique
  on public.mensagens (company_id, conversa_id, client_temp_id)
  where client_temp_id is not null
    and btrim(client_temp_id) <> '';

comment on column public.mensagens.client_temp_id is
  'Frontend-generated idempotency key for outbound manual sends; unique per company/conversation when present.';

comment on index public.idx_mensagens_client_temp_id_unique is
  'Prevents duplicate outbound messages for the same client_temp_id within a company/conversation.';
