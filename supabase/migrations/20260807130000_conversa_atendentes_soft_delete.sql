-- Colunas de auditoria para soft-delete em conversa_atendentes.
-- O handler removerAtendenteConversa define ativo=false + removido_em + removido_por.

ALTER TABLE public.conversa_atendentes
  ADD COLUMN IF NOT EXISTS removido_em timestamp with time zone,
  ADD COLUMN IF NOT EXISTS removido_por integer REFERENCES public.usuarios(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.conversa_atendentes.removido_em IS 'Timestamp de quando o co-atendente foi removido (NULL = ativo).';
COMMENT ON COLUMN public.conversa_atendentes.removido_por IS 'Usuário que realizou a remoção.';
