-- Recarrega o schema cache do PostgREST/Supabase apos migrations de whatsapp_instances.
-- Nao altera dados. Ajuda quando a tabela existe no Postgres, mas a API REST ainda retorna
-- "Could not find the table 'public.whatsapp_instances' in the schema cache".

do $$
begin
  perform pg_notify('pgrst', 'reload schema');
end $$;
