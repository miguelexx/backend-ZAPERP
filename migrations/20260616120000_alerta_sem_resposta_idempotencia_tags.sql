-- Idempotencia para tag automatica do alerta sem resposta.
-- Permite o mesmo nome de tag em empresas diferentes e impede tag duplicada na mesma conversa.

ALTER TABLE public.tags
  DROP CONSTRAINT IF EXISTS tags_nome_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_company_nome_unique
  ON public.tags (company_id, nome)
  WHERE company_id IS NOT NULL;

DELETE FROM public.conversa_tags ct
USING public.conversa_tags keep
WHERE ct.company_id IS NOT NULL
  AND ct.conversa_id IS NOT NULL
  AND ct.tag_id IS NOT NULL
  AND keep.company_id = ct.company_id
  AND keep.conversa_id = ct.conversa_id
  AND keep.tag_id = ct.tag_id
  AND keep.id < ct.id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversa_tags_company_conversa_tag_unique
  ON public.conversa_tags (company_id, conversa_id, tag_id)
  WHERE company_id IS NOT NULL
    AND conversa_id IS NOT NULL
    AND tag_id IS NOT NULL;
