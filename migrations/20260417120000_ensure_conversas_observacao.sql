-- Garante coluna de observações do atendimento (alguns deploys não aplicaram 20250205000000).
ALTER TABLE public.conversas
ADD COLUMN IF NOT EXISTS observacao text;

COMMENT ON COLUMN public.conversas.observacao IS 'Observações do atendimento / resumo da conversa';
