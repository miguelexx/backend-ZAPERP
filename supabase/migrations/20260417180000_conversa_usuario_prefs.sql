-- Preferências por usuário e por conversa (silenciar, fixar, favoritar).
-- Usado pela lista lateral de chats (menu estilo WhatsApp Web).

CREATE TABLE IF NOT EXISTS public.conversa_usuario_prefs (
  id bigserial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  usuario_id integer NOT NULL REFERENCES public.usuarios(id) ON DELETE CASCADE,
  conversa_id integer NOT NULL REFERENCES public.conversas(id) ON DELETE CASCADE,
  silenciada boolean NOT NULL DEFAULT false,
  fixada boolean NOT NULL DEFAULT false,
  favorita boolean NOT NULL DEFAULT false,
  fixada_em timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversa_usuario_prefs_unique UNIQUE (company_id, usuario_id, conversa_id)
);

CREATE INDEX IF NOT EXISTS idx_conversa_usuario_prefs_lookup
  ON public.conversa_usuario_prefs (company_id, usuario_id);

CREATE INDEX IF NOT EXISTS idx_conversa_usuario_prefs_conversa
  ON public.conversa_usuario_prefs (company_id, conversa_id);

COMMENT ON TABLE public.conversa_usuario_prefs IS 'Preferências do atendente por conversa: silenciar notificações, fixar no topo, favoritar. Escopo por (empresa, usuário, conversa).';
