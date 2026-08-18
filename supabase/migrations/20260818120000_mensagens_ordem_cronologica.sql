BEGIN;

ALTER TABLE public.mensagens
  ADD COLUMN IF NOT EXISTS message_timestamp timestamptz;

-- O schema legado usa timestamp sem fuso e a aplicação sempre o interpretou como UTC.
-- O bloco também funciona em instalações onde criado_em já foi convertido para timestamptz.
DO $$
DECLARE
  criado_em_type text;
BEGIN
  SELECT data_type
    INTO criado_em_type
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'mensagens'
     AND column_name = 'criado_em';

  IF criado_em_type = 'timestamp without time zone' THEN
    UPDATE public.mensagens
       SET message_timestamp = COALESCE(criado_em AT TIME ZONE 'UTC', now())
     WHERE message_timestamp IS NULL;
  ELSE
    UPDATE public.mensagens
       SET message_timestamp = COALESCE(criado_em, now())
     WHERE message_timestamp IS NULL;
  END IF;
END $$;

ALTER TABLE public.mensagens
  ALTER COLUMN message_timestamp DROP DEFAULT;

-- Validar em duas etapas reduz o período de lock exclusivo no SET NOT NULL.
ALTER TABLE public.mensagens
  ADD CONSTRAINT mensagens_message_timestamp_nn
  CHECK (message_timestamp IS NOT NULL) NOT VALID;
ALTER TABLE public.mensagens
  VALIDATE CONSTRAINT mensagens_message_timestamp_nn;
ALTER TABLE public.mensagens
  ALTER COLUMN message_timestamp SET NOT NULL;
ALTER TABLE public.mensagens
  DROP CONSTRAINT mensagens_message_timestamp_nn;

CREATE OR REPLACE FUNCTION public.mensagens_definir_message_timestamp()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.message_timestamp IS NULL THEN
    IF pg_typeof(NEW.criado_em)::text = 'timestamp without time zone' THEN
      NEW.message_timestamp := COALESCE(NEW.criado_em AT TIME ZONE 'UTC', clock_timestamp());
    ELSE
      NEW.message_timestamp := COALESCE(NEW.criado_em::timestamptz, clock_timestamp());
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mensagens_definir_message_timestamp ON public.mensagens;
CREATE TRIGGER trg_mensagens_definir_message_timestamp
BEFORE INSERT ON public.mensagens
FOR EACH ROW
EXECUTE FUNCTION public.mensagens_definir_message_timestamp();

COMMENT ON COLUMN public.mensagens.message_timestamp IS
  'Instante cronológico imutável da mensagem em UTC: horário original do provedor ou recebimento da requisição pelo servidor.';

COMMIT;

-- Fora da transação: não bloqueia INSERT/UPDATE enquanto o índice do histórico é criado.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_mensagens_company_conversa_message_timestamp_id
  ON public.mensagens (company_id, conversa_id, message_timestamp DESC, id DESC);

-- Rollback operacional (executar separadamente somente se necessário):
-- DROP TRIGGER IF EXISTS trg_mensagens_definir_message_timestamp ON public.mensagens;
-- DROP FUNCTION IF EXISTS public.mensagens_definir_message_timestamp();
-- DROP INDEX IF EXISTS public.idx_mensagens_company_conversa_message_timestamp_id;
-- ALTER TABLE public.mensagens DROP COLUMN IF EXISTS message_timestamp;
