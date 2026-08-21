-- Etapa 3: campos de distribuição de instâncias na campanha.
-- Seguro: apenas ADD COLUMN IF NOT EXISTS — não altera dados existentes.

ALTER TABLE public.disparo_campanhas
  ADD COLUMN IF NOT EXISTS distribuicao_modo text
    CHECK (distribuicao_modo IS NULL OR distribuicao_modo IN (
      'equilibrada', 'quantidade', 'percentual', 'manual'
    )),
  ADD COLUMN IF NOT EXISTS distribuicao_confirmada boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS distribuicao_revisao     boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.disparo_campanhas.distribuicao_modo IS
  'Modo de distribuição dos destinatários entre instâncias: equilibrada | quantidade | percentual | manual';
COMMENT ON COLUMN public.disparo_campanhas.distribuicao_confirmada IS
  'True quando a distribuição foi calculada e confirmada pelo administrador.';
COMMENT ON COLUMN public.disparo_campanhas.distribuicao_revisao IS
  'True quando destinatários foram adicionados/removidos após a distribuição ser confirmada — exige nova revisão.';
