-- Respostas salvas: vincular ao usuário que criou (uso pessoal no atendimento)
ALTER TABLE public.respostas_salvas
  ADD COLUMN IF NOT EXISTS usuario_id integer REFERENCES public.usuarios(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_respostas_salvas_company_usuario
  ON public.respostas_salvas (company_id, usuario_id);

COMMENT ON COLUMN public.respostas_salvas.usuario_id IS 'Atendente dono da resposta salva; listagem no atendimento filtra por este campo.';

-- Registros antigos sem dono permanecem no banco mas não aparecem na API (filtro por usuario_id).
-- Novas inserções exigem usuario_id via aplicação; não atribuir dono automaticamente a legado.
