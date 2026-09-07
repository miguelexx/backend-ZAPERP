-- Edição de mensagem (texto / legenda de mídia). Aditivo; não apaga dados.
-- WhatsApp: janela ~15 min; o CRM persiste a flag para o badge após F5.

ALTER TABLE public.mensagens
  ADD COLUMN IF NOT EXISTS editada boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS editada_em timestamptz;

COMMENT ON COLUMN public.mensagens.editada IS
  'True quando o texto/legenda foi editado no WhatsApp ou no CRM (nota interna).';
COMMENT ON COLUMN public.mensagens.editada_em IS
  'Instante da última edição persistida. Null se nunca editada.';
