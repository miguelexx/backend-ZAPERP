-- =====================================================
-- Usuários com múltiplos departamentos (N:N)
-- Permite que um usuário pertença a Comercial e Financeiro, etc.
-- =====================================================

-- Tabela de associação usuario <-> departamento (N:N)
CREATE TABLE IF NOT EXISTS public.usuario_departamentos (
  id bigserial PRIMARY KEY,
  usuario_id integer NOT NULL,
  departamento_id integer NOT NULL,
  company_id integer NOT NULL,
  criado_em timestamp with time zone DEFAULT now(),
  CONSTRAINT usuario_departamentos_usuario_fk FOREIGN KEY (usuario_id) REFERENCES public.usuarios(id) ON DELETE CASCADE,
  CONSTRAINT usuario_departamentos_departamento_fk FOREIGN KEY (departamento_id) REFERENCES public.departamentos(id) ON DELETE CASCADE,
  CONSTRAINT usuario_departamentos_company_fk FOREIGN KEY (company_id) REFERENCES public.empresas(id) ON DELETE CASCADE,
  CONSTRAINT usuario_departamentos_unique UNIQUE (usuario_id, departamento_id)
);

CREATE INDEX IF NOT EXISTS idx_usuario_departamentos_usuario ON public.usuario_departamentos(usuario_id);
CREATE INDEX IF NOT EXISTS idx_usuario_departamentos_departamento ON public.usuario_departamentos(departamento_id);
CREATE INDEX IF NOT EXISTS idx_usuario_departamentos_company ON public.usuario_departamentos(company_id);

COMMENT ON TABLE public.usuario_departamentos IS 'Associação N:N entre usuários e departamentos. Um usuário pode pertencer a vários setores (ex: Comercial e Financeiro).';

-- Migrar dados existentes: usuarios.departamento_id -> usuario_departamentos
INSERT INTO public.usuario_departamentos (usuario_id, departamento_id, company_id)
SELECT id, departamento_id, company_id
FROM public.usuarios
WHERE departamento_id IS NOT NULL
  AND company_id IS NOT NULL
ON CONFLICT (usuario_id, departamento_id) DO NOTHING;
