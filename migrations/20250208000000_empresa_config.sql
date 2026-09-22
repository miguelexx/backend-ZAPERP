-- Configurações extras da empresa (Geral do painel admin)
ALTER TABLE public.empresas ADD COLUMN IF NOT EXISTS logo_url text;
ALTER TABLE public.empresas ADD COLUMN IF NOT EXISTS tema varchar(20) DEFAULT 'light';
ALTER TABLE public.empresas ADD COLUMN IF NOT EXISTS cor_primaria varchar(20) DEFAULT '#2563eb';
ALTER TABLE public.empresas ADD COLUMN IF NOT EXISTS horario_inicio time DEFAULT '09:00';
ALTER TABLE public.empresas ADD COLUMN IF NOT EXISTS horario_fim time DEFAULT '18:00';
