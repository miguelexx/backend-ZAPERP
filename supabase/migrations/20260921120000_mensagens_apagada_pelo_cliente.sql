-- Cliente apagou "para todos" no WhatsApp: registramos internamente SEM esconder o conteúdo.
-- O atendente continua vendo a mensagem original; só ganha um aviso discreto de que o
-- contato a apagou. Diferente de `apagada_para_todos` (revogação nossa, que oculta o texto).

ALTER TABLE public.mensagens
  ADD COLUMN IF NOT EXISTS apagada_pelo_cliente boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS apagada_pelo_cliente_em timestamptz;

CREATE INDEX IF NOT EXISTS idx_mensagens_conversa_apagada_cliente
  ON public.mensagens (company_id, conversa_id, apagada_pelo_cliente)
  WHERE apagada_pelo_cliente = true;

COMMENT ON COLUMN public.mensagens.apagada_pelo_cliente IS
  'O contato apagou a mensagem para todos no WhatsApp. Conteúdo permanece visível no painel; exibe aviso discreto. NÃO confundir com apagada_para_todos (revogação feita pelo atendente).';
