-- Ordenação correta da lista (por última atividade) e mensagens únicas por conversa
-- 1) Coluna ultima_atividade em conversas (para ordenar lista)
-- 2) Índice único em mensagens(conversa_id, whatsapp_id) para evitar duplicatas

ALTER TABLE public.conversas
  ADD COLUMN IF NOT EXISTS ultima_atividade timestamp with time zone DEFAULT now();

COMMENT ON COLUMN public.conversas.ultima_atividade IS 'Última atividade na conversa (nova mensagem ou envio). Usado para ordenar a lista.';

-- Preencher com o máximo de criado_em das mensagens (ou criado_em da conversa)
UPDATE public.conversas c
SET ultima_atividade = COALESCE(
  (SELECT max(m.criado_em) FROM public.mensagens m WHERE m.conversa_id = c.id),
  c.criado_em
)
WHERE c.ultima_atividade IS NULL OR c.ultima_atividade = c.criado_em;

-- Remover mensagens duplicadas (mesmo conversa_id + whatsapp_id), mantendo a de menor id
DELETE FROM public.mensagens a
USING public.mensagens b
WHERE a.conversa_id = b.conversa_id
  AND a.whatsapp_id = b.whatsapp_id
  AND a.whatsapp_id IS NOT NULL AND a.whatsapp_id != ''
  AND a.id > b.id;

-- Índice único: uma mensagem por (conversa_id, whatsapp_id) quando whatsapp_id preenchido
CREATE UNIQUE INDEX IF NOT EXISTS idx_mensagens_conversa_whatsapp_id
  ON public.mensagens (conversa_id, whatsapp_id)
  WHERE whatsapp_id IS NOT NULL AND whatsapp_id != '';
