-- Adiciona coluna observacao na tabela conversas (observações do atendimento)
ALTER TABLE public.conversas
ADD COLUMN IF NOT EXISTS observacao text;

COMMENT ON COLUMN public.conversas.observacao IS 'Observações do atendimento / resumo da conversa';
