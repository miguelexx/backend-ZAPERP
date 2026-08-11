-- Adiciona colunas que podem estar faltando na tabela conversa_atendentes
-- (tabela foi criada em produção sem a migration original completa)
ALTER TABLE public.conversa_atendentes
  ADD COLUMN IF NOT EXISTS adicionado_por integer REFERENCES public.usuarios(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS removido_em timestamp with time zone,
  ADD COLUMN IF NOT EXISTS removido_por integer REFERENCES public.usuarios(id) ON DELETE SET NULL;
