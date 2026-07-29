-- ============================================================
-- Permissões granulares por usuário
-- Permite sobrescrever as permissões padrão do perfil (admin/supervisor/atendente)
-- com permissões específicas por usuário.
--
-- Relocado de supabase/migrations/20260308000000_usuario_permissoes.sql
-- (diretório raiz, descontinuado em 2026-06-30 — backend/supabase/migrations/
-- é o único diretório de migrations a partir de agora). Nunca havia sido
-- aplicada: backend/helpers/permissoesService.js já dependia desta tabela,
-- então salvar permissões customizadas por usuário falhava em produção.
-- ============================================================

CREATE SEQUENCE IF NOT EXISTS usuario_permissoes_id_seq;

-- Tabela de permissões atribuídas ao usuário (override do perfil)
CREATE TABLE IF NOT EXISTS public.usuario_permissoes (
  id bigint NOT NULL DEFAULT nextval('usuario_permissoes_id_seq'::regclass),
  usuario_id integer NOT NULL,
  company_id integer NOT NULL,
  permissao_codigo varchar(100) NOT NULL,
  concedido boolean NOT NULL DEFAULT true,
  criado_em timestamp with time zone DEFAULT now(),
  CONSTRAINT usuario_permissoes_pkey PRIMARY KEY (id),
  CONSTRAINT usuario_permissoes_usuario_fk FOREIGN KEY (usuario_id) REFERENCES public.usuarios(id) ON DELETE CASCADE,
  CONSTRAINT usuario_permissoes_company_fk FOREIGN KEY (company_id) REFERENCES public.empresas(id) ON DELETE CASCADE,
  CONSTRAINT usuario_permissoes_unique UNIQUE (usuario_id, permissao_codigo)
);

CREATE INDEX IF NOT EXISTS idx_usuario_permissoes_usuario ON public.usuario_permissoes(usuario_id);
CREATE INDEX IF NOT EXISTS idx_usuario_permissoes_company ON public.usuario_permissoes(company_id);
CREATE INDEX IF NOT EXISTS idx_usuario_permissoes_codigo ON public.usuario_permissoes(permissao_codigo);

COMMENT ON TABLE public.usuario_permissoes IS 'Permissões granulares por usuário; sobrescreve o padrão do perfil quando definido.';
COMMENT ON COLUMN public.usuario_permissoes.concedido IS 'true = permitido, false = negado explicitamente (override do perfil).';
