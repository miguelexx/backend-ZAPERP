-- Rodar no Supabase SQL Editor (idempotente).
-- Registra quando o CLIENTE apaga uma mensagem "para todos" no WhatsApp, SEM esconder o
-- conteúdo: o atendente segue vendo a mensagem original e ganha só um aviso discreto.

ALTER TABLE public.mensagens
  ADD COLUMN IF NOT EXISTS apagada_pelo_cliente boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS apagada_pelo_cliente_em timestamptz;

CREATE INDEX IF NOT EXISTS idx_mensagens_conversa_apagada_cliente
  ON public.mensagens (company_id, conversa_id, apagada_pelo_cliente)
  WHERE apagada_pelo_cliente = true;
