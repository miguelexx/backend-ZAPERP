-- Pós-deploy seguro: garante que o alerta de resumo ao administrador fique DESLIGADO
-- em todas as empresas que já possuem ia_config. Ativação apenas manual no painel (IA → seção 8).
-- Não remove outras chaves em admin_atendimento_alerta (telefone, horário, toggles de métricas).

UPDATE public.ia_config
SET
  config = jsonb_set(
    COALESCE(config, '{}'::jsonb),
    '{admin_atendimento_alerta,ativo}',
    'false'::jsonb,
    true
  ),
  updated_at = now()
WHERE true;
