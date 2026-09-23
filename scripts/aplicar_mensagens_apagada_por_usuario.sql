-- Rodar no Supabase SQL Editor (idempotente).
-- Registra QUEM (atendente/admin) apagou uma mensagem "para todos", para o painel exibir
-- o aviso de auditoria "Fulano apagou esta mensagem · data/hora" mantendo o conteúdo original.

ALTER TABLE public.mensagens
  ADD COLUMN IF NOT EXISTS apagada_por_usuario_id bigint;
