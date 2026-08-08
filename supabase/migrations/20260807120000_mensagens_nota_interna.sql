-- Suporte a notas internas no thread de mensagens.
-- Uma nota interna usa tipo='internal_note' e direcao='interna'.
-- Nunca sai para o WhatsApp.

-- Remove qualquer check constraint em direcao que bloquearia o valor 'interna'.
-- (Seguro: a constraint pode não existir; o DO-block verifica antes de dropar.)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.mensagens'::regclass
      AND contype = 'c'
      AND conname ILIKE '%direcao%'
  ) THEN
    EXECUTE (
      SELECT 'ALTER TABLE public.mensagens DROP CONSTRAINT ' || quote_ident(conname)
      FROM pg_constraint
      WHERE conrelid = 'public.mensagens'::regclass
        AND contype = 'c'
        AND conname ILIKE '%direcao%'
      LIMIT 1
    );
  END IF;
END $$;

-- Índice para listar notas internas de uma conversa com performance
CREATE INDEX IF NOT EXISTS idx_mensagens_nota_interna
  ON public.mensagens (company_id, conversa_id, criado_em DESC)
  WHERE tipo = 'internal_note';

COMMENT ON COLUMN public.mensagens.autor_usuario_id IS 'Usuário que criou a nota interna (NULL para mensagens normais).';
