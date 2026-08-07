-- Suporte a notas internas no thread de mensagens.
-- Uma nota interna usa tipo='internal_note', direcao='interna', status='interna'
-- e nunca sai para o WhatsApp.

-- Autor da nota interna (usuario que criou, nullable para msgs normais)
ALTER TABLE public.mensagens
  ADD COLUMN IF NOT EXISTS autor_usuario_id integer REFERENCES public.usuarios(id) ON DELETE SET NULL;

-- Índice para listar/verificar notas internas de uma conversa com performance
CREATE INDEX IF NOT EXISTS idx_mensagens_nota_interna
  ON public.mensagens (company_id, conversa_id, criado_em DESC)
  WHERE tipo = 'internal_note';

-- Garante que a coluna pode ser lida via PostgREST
COMMENT ON COLUMN public.mensagens.autor_usuario_id IS 'Usuário que criou a nota interna (NULL para mensagens normais).';
