-- Cartão de contato: metadados para exibir nome, telefone e foto no frontend
-- Usado quando mensagens.tipo = 'contact'
ALTER TABLE public.mensagens
ADD COLUMN IF NOT EXISTS contact_meta jsonb DEFAULT NULL;

COMMENT ON COLUMN public.mensagens.contact_meta IS 'Metadados do contato compartilhado: { nome, telefone, foto_perfil? }. Usado com tipo=contact.';
