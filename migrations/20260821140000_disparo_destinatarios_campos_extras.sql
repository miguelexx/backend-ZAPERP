-- Etapa 2: campos extras para rastreabilidade dos destinatários.
-- Seguro: apenas ADD COLUMN IF NOT EXISTS — não altera nem remove dados existentes.

ALTER TABLE public.disparo_campanha_destinatarios
  ADD COLUMN IF NOT EXISTS arquivo_origem   varchar(255),
  ADD COLUMN IF NOT EXISTS linha_planilha   integer,
  ADD COLUMN IF NOT EXISTS adicionado_por   integer REFERENCES public.usuarios(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS disparo_destinatarios_adicionado_por_idx
  ON public.disparo_campanha_destinatarios (adicionado_por);
