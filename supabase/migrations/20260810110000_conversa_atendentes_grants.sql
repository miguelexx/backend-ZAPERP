-- Concede permissoes de acesso a tabela conversa_atendentes
-- (criada via SQL sem GRANT automatico do dashboard)
GRANT ALL ON TABLE public.conversa_atendentes TO service_role;
GRANT ALL ON TABLE public.conversa_atendentes TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.conversa_atendentes_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.conversa_atendentes_id_seq TO authenticated;
