-- Trava de visão: quais atendentes podem ver as conversas de cada número WhatsApp.
-- Sem linhas para um atendente = ele continua vendo todos os números (comportamento atual).
-- Admin e supervisor não usam esta tabela.

CREATE TABLE IF NOT EXISTS public.usuario_whatsapp_instances (
  id bigserial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  usuario_id integer NOT NULL REFERENCES public.usuarios(id) ON DELETE CASCADE,
  whatsapp_instance_id bigint NOT NULL REFERENCES public.whatsapp_instances(id) ON DELETE CASCADE,
  criado_em timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT usuario_whatsapp_instances_unique UNIQUE (company_id, usuario_id, whatsapp_instance_id)
);

COMMENT ON TABLE public.usuario_whatsapp_instances IS
  'Atendentes liberados para ver conversas de um número WhatsApp. Sem linha = sem trava.';

CREATE INDEX IF NOT EXISTS idx_usuario_whatsapp_instances_usuario
  ON public.usuario_whatsapp_instances (company_id, usuario_id);

CREATE INDEX IF NOT EXISTS idx_usuario_whatsapp_instances_instancia
  ON public.usuario_whatsapp_instances (company_id, whatsapp_instance_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.usuario_whatsapp_instances TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.usuario_whatsapp_instances_id_seq TO service_role;

NOTIFY pgrst, 'reload schema';
