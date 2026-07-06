-- Modo simples de atendimento: controle visual por última mensagem real (opcional por empresa).

ALTER TABLE empresas
  ADD COLUMN IF NOT EXISTS atendimento_modo_simples boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN empresas.atendimento_modo_simples IS
  'Quando true, a UI e a lógica de aguardando usam apenas modo_simples_aguardando (atendente/cliente) pela última mensagem real; não exige assumir nem encerrar.';

ALTER TABLE conversas
  ADD COLUMN IF NOT EXISTS modo_simples_aguardando text;

ALTER TABLE conversas
  DROP CONSTRAINT IF EXISTS conversas_modo_simples_aguardando_check;

ALTER TABLE conversas
  ADD CONSTRAINT conversas_modo_simples_aguardando_check
  CHECK (modo_simples_aguardando IS NULL OR modo_simples_aguardando IN ('atendente', 'cliente'));

COMMENT ON COLUMN conversas.modo_simples_aguardando IS
  'Preenchido quando a empresa usa atendimento_modo_simples: atendente = última msg do cliente; cliente = última msg outbound qualificada.';

CREATE INDEX IF NOT EXISTS idx_conversas_modo_simples_aguardando
  ON conversas (company_id, modo_simples_aguardando)
  WHERE modo_simples_aguardando IS NOT NULL;
