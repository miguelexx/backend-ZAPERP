-- Unificar conversa quando Z-API envia mesmo chat com phone real (recebido) e phone @lid (enviado).
-- chat_lid = parte numérica do chatLid (ex.: 28291218030616) para resolver mesma conversa.
ALTER TABLE public.conversas
  ADD COLUMN IF NOT EXISTS chat_lid text;

COMMENT ON COLUMN public.conversas.chat_lid IS 'LID do chat Z-API (parte antes de @lid) para unificar conversa recebida (phone real) e enviada (phone @lid).';

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversas_company_chat_lid
  ON public.conversas (company_id, chat_lid)
  WHERE chat_lid IS NOT NULL;

COMMENT ON INDEX public.idx_conversas_company_chat_lid
  IS 'Uma conversa por company_id + chat_lid; usado para resolver LID no webhook Z-API.';
