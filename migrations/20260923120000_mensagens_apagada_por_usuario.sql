-- Auditoria de exclusão "para todos" feita pelo NOSSO atendente.
-- Diferente da revogação antiga (que escondia o texto), agora mantemos o conteúdo
-- original visível no painel e só exibimos um aviso "Fulano apagou esta mensagem · data/hora".
-- Para mostrar QUEM apagou (pode ser o autor ou um admin), registramos o usuário.

ALTER TABLE public.mensagens
  ADD COLUMN IF NOT EXISTS apagada_por_usuario_id bigint;

COMMENT ON COLUMN public.mensagens.apagada_por_usuario_id IS
  'Usuário (atendente/admin) que apagou a mensagem "para todos". Usado no aviso de auditoria; NULL quando quem apagou foi o próprio contato (ver apagada_pelo_cliente).';
