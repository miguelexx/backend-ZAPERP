-- Suporte a conversas de grupo: remetente na mensagem (ex: "João: oi")
-- conversas já possui tipo (cliente|grupo|comunidade) e nome_grupo
--
-- COMO APLICAR: Supabase Dashboard > SQL Editor > colar e executar este script.

ALTER TABLE public.mensagens
  ADD COLUMN IF NOT EXISTS remetente_nome varchar(255),
  ADD COLUMN IF NOT EXISTS remetente_telefone varchar(50);

COMMENT ON COLUMN public.mensagens.remetente_nome IS 'Nome do participante que enviou a mensagem (grupos)';
COMMENT ON COLUMN public.mensagens.remetente_telefone IS 'Telefone do participante que enviou a mensagem (grupos)';
