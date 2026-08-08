-- Suporte a notas internas no thread de mensagens.
-- Uma nota interna usa tipo='internal_note' e direcao='interna'.
-- Nunca sai para o WhatsApp.

-- Remove qualquer check constraint na coluna direcao que bloquearia o valor 'interna'.
-- Busca por nome (ILIKE '%direcao%') E por coluna referenciada (mais robusto).
DO $$
DECLARE
  rec record;
BEGIN
  -- Estratégia 1: pelo nome da constraint
  FOR rec IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.mensagens'::regclass
      AND contype = 'c'
      AND conname ILIKE '%direcao%'
  LOOP
    EXECUTE 'ALTER TABLE public.mensagens DROP CONSTRAINT ' || quote_ident(rec.conname);
  END LOOP;

  -- Estratégia 2: pela coluna referenciada (captura constraints sem 'direcao' no nome)
  FOR rec IN
    SELECT DISTINCT c.conname
    FROM pg_constraint c
    JOIN pg_attribute a
      ON a.attrelid = c.conrelid
     AND a.attnum = ANY(c.conkey)
    WHERE c.conrelid = 'public.mensagens'::regclass
      AND c.contype = 'c'
      AND a.attname = 'direcao'
      AND c.conname NOT ILIKE '%direcao%'  -- já dropadas acima
  LOOP
    EXECUTE 'ALTER TABLE public.mensagens DROP CONSTRAINT ' || quote_ident(rec.conname);
  END LOOP;
END $$;

-- Índice para listar notas internas de uma conversa com performance
CREATE INDEX IF NOT EXISTS idx_mensagens_nota_interna
  ON public.mensagens (company_id, conversa_id, criado_em DESC)
  WHERE tipo = 'internal_note';

COMMENT ON COLUMN public.mensagens.autor_usuario_id IS 'Usuário que criou a nota interna (NULL para mensagens normais).';
