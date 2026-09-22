-- Corrige "permission denied for table alerta_atendimento_sem_resposta_*" em ambientes
-- onde as tabelas foram criadas antes dos GRANTs (idempotente).

GRANT ALL ON TABLE public.alerta_atendimento_sem_resposta_eventos TO postgres, service_role;
GRANT ALL ON TABLE public.alerta_atendimento_sem_resposta_estado TO postgres, service_role;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'S'
      AND c.relname = 'alerta_atendimento_sem_resposta_eventos_id_seq'
  ) THEN
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE public.alerta_atendimento_sem_resposta_eventos_id_seq TO postgres, service_role';
  END IF;
END $$;
