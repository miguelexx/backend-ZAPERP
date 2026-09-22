-- Tokens FCM (Firebase Cloud Messaging) por dispositivo — PWA / mobile Web Push via Firebase

CREATE TABLE IF NOT EXISTS public.push_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id integer NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  usuario_id integer NOT NULL REFERENCES public.usuarios(id) ON DELETE CASCADE,
  token text NOT NULL,
  plataforma text,
  navegador text,
  dispositivo text,
  ativo boolean NOT NULL DEFAULT true,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  ultimo_uso_em timestamptz,
  CONSTRAINT push_tokens_token_uq UNIQUE (token)
);

CREATE INDEX IF NOT EXISTS idx_push_tokens_empresa_usuario
  ON public.push_tokens (empresa_id, usuario_id);

CREATE INDEX IF NOT EXISTS idx_push_tokens_token
  ON public.push_tokens (token);

CREATE INDEX IF NOT EXISTS idx_push_tokens_empresa_ativo
  ON public.push_tokens (empresa_id, ativo);

COMMENT ON TABLE public.push_tokens IS 'Tokens FCM por atendente/dispositivo; credenciais Firebase apenas no backend.';
