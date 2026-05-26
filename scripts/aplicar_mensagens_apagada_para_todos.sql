-- Rodar no Supabase SQL Editor (idempotente).

ALTER TABLE public.mensagens
  ADD COLUMN IF NOT EXISTS apagada_para_todos boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS apagada_em timestamptz;

CREATE INDEX IF NOT EXISTS idx_mensagens_conversa_apagada
  ON public.mensagens (company_id, conversa_id, apagada_para_todos)
  WHERE apagada_para_todos = true;
