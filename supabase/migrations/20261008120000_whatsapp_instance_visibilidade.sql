-- Controle de visibilidade por numero WhatsApp (whatsapp_instances) por usuario.
-- Migration ADITIVA: nao altera conversas, mensagens nem whatsapp_instances.
-- Semantica:
--   * Numero SEM linha nesta tabela  -> sem restricao (todos veem) = comportamento de hoje.
--   * Numero COM 1+ linhas           -> SOMENTE os usuarios listados veem as conversas desse numero.
--   * "Todos veem este numero"       -> apagar as linhas desse numero (volta ao padrao).
-- Isolamento multi-tenant: toda linha carrega company_id; FKs com ON DELETE CASCADE.

CREATE TABLE IF NOT EXISTS public.whatsapp_instance_visibilidade (
  id bigserial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  whatsapp_instance_id bigint NOT NULL REFERENCES public.whatsapp_instances(id) ON DELETE CASCADE,
  usuario_id integer NOT NULL REFERENCES public.usuarios(id) ON DELETE CASCADE,
  criado_em timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT uq_whatsapp_instance_visibilidade UNIQUE (company_id, whatsapp_instance_id, usuario_id)
);

COMMENT ON TABLE public.whatsapp_instance_visibilidade IS
  'Quais usuarios podem ver as conversas de cada numero WhatsApp (whatsapp_instances). Sem linha para um numero = todos veem (padrao).';

-- Busca "quais numeros estao bloqueados para este usuario" (lista/contadores) e
-- "quais usuarios veem este numero" (socket/unread/push).
CREATE INDEX IF NOT EXISTS idx_whatsapp_instance_visibilidade_company_usuario
  ON public.whatsapp_instance_visibilidade (company_id, usuario_id);

CREATE INDEX IF NOT EXISTS idx_whatsapp_instance_visibilidade_company_instance
  ON public.whatsapp_instance_visibilidade (company_id, whatsapp_instance_id);

-- Substitui atomicamente o conjunto de usuarios que veem um numero.
-- Valida: a instancia precisa pertencer a empresa e estar ativa; so grava usuarios
-- ativos da mesma empresa. Array vazio/NULL = "todos veem" (apenas apaga as linhas).
CREATE OR REPLACE FUNCTION public.set_whatsapp_instance_visibilidade(
  p_company integer,
  p_instance bigint,
  p_user_ids integer[]
) RETURNS void AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.whatsapp_instances wi
     WHERE wi.id = p_instance AND wi.company_id = p_company AND wi.ativo = true
  ) THEN
    RAISE EXCEPTION 'whatsapp_instance % nao pertence a empresa % ou esta inativa', p_instance, p_company
      USING ERRCODE = 'check_violation';
  END IF;

  DELETE FROM public.whatsapp_instance_visibilidade
   WHERE company_id = p_company AND whatsapp_instance_id = p_instance;

  IF p_user_ids IS NOT NULL AND array_length(p_user_ids, 1) > 0 THEN
    INSERT INTO public.whatsapp_instance_visibilidade (company_id, whatsapp_instance_id, usuario_id)
    SELECT p_company, p_instance, u.id
      FROM public.usuarios u
     WHERE u.company_id = p_company
       AND u.ativo = true
       AND u.id = ANY(p_user_ids)
    ON CONFLICT (company_id, whatsapp_instance_id, usuario_id) DO NOTHING;
  END IF;
END;
$$ LANGUAGE plpgsql;
