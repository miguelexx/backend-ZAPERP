-- CRM opcional por empresa: administrador pode desativar módulo (ocultar «Enviar ao CRM», bloquear API).
ALTER TABLE public.empresas
  ADD COLUMN IF NOT EXISTS crm_habilitado boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.empresas.crm_habilitado IS 'Se false, CRM desativado para o tenant (UI + POST/GET /crm retornam 403).';
