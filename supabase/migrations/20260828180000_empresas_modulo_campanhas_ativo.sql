-- Módulo Campanhas/Disparo: só aparece na UI e nas rotas /disparo
-- quando o admin ativa em Configurações gerais (senha de ativação no backend).
-- Default false: empresas existentes continuam sem o módulo até ativar.

BEGIN;

ALTER TABLE public.empresas
  ADD COLUMN IF NOT EXISTS modulo_campanhas_ativo boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.empresas.modulo_campanhas_ativo IS
  'Quando true, a empresa pode usar o módulo Disparo (menu/rotas) e o filtro Campanhas na lista de conversas. Ativação exige senha no PUT /config/empresa (não armazenada no banco). Isolamento por company_id na aplicação.';

NOTIFY pgrst, 'reload schema';

COMMIT;
