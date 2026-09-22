-- Suporte a registro de transferência de setor em historico_atendimentos
ALTER TABLE public.historico_atendimentos
  ADD COLUMN IF NOT EXISTS observacao text;

COMMENT ON COLUMN public.historico_atendimentos.observacao IS 'Ex: "Financeiro -> Suporte" em transferência de setor';
