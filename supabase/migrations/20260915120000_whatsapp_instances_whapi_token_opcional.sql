-- =====================================================================
-- instance_token opcional para provider 'whapi'.
-- ADITIVA / não destrutiva: não altera dados existentes.
--
-- Problema: whatsapp_instances.instance_token era text NOT NULL, então
-- inserir um canal Whapi sem token (ex.: cadastrar o channel_id primeiro e
-- preencher o Bearer depois) violava a NOT NULL constraint.
--
-- Regra após esta migration:
--   provider='ultramsg' -> instance_token OBRIGATÓRIO e não-vazio (inalterado)
--   provider='whapi'    -> instance_token OPCIONAL (pode ficar NULL)
--
-- Atenção: o adapter Whapi (services/providers/whapi/config.js) SÓ envia com
-- token presente — uma instância Whapi sem instance_token não dispara até o
-- Bearer ser preenchido. Isto apenas permite cadastrar/salvar sem o token.
--
-- ORDEM: aplicar ANTES de qualquer insert Whapi sem token.
-- NÃO aplicada automaticamente — Miguel aplica.
-- Ver docs/ai-handoff/25-WHAPI-SEGUNDA-INTEGRACAO.md
-- =====================================================================

BEGIN;

-- 1) Remove o NOT NULL da coluna (Whapi pode ficar sem token).
ALTER TABLE public.whatsapp_instances
  ALTER COLUMN instance_token DROP NOT NULL;

-- 2) Substitui a CHECK "not blank" por uma condicional por provider.
--    UltraMSG continua exigindo token não-vazio; Whapi aceita NULL/vazio.
ALTER TABLE public.whatsapp_instances
  DROP CONSTRAINT IF EXISTS whatsapp_instances_instance_token_not_blank;

ALTER TABLE public.whatsapp_instances
  ADD CONSTRAINT whatsapp_instances_instance_token_not_blank
  CHECK (
    provider <> 'ultramsg'
    OR (instance_token IS NOT NULL AND length(btrim(instance_token)) > 0)
  );

COMMENT ON CONSTRAINT whatsapp_instances_instance_token_not_blank ON public.whatsapp_instances
  IS 'UltraMSG exige instance_token não-vazio. Whapi pode ficar NULL (Bearer preenchido depois).';

COMMENT ON COLUMN public.whatsapp_instances.instance_token IS
  'Segredo da API. UltraMSG: obrigatório (token). Whapi: opcional (Authorization Bearer) — pode ficar NULL até ser configurado. Nunca expor em respostas públicas.';

COMMIT;

-- =====================================================================
-- Rollback (SÓ se nenhuma linha whapi tiver instance_token NULL/vazio):
--   BEGIN;
--   ALTER TABLE public.whatsapp_instances
--     DROP CONSTRAINT IF EXISTS whatsapp_instances_instance_token_not_blank;
--   ALTER TABLE public.whatsapp_instances
--     ADD CONSTRAINT whatsapp_instances_instance_token_not_blank
--     CHECK (length(btrim(instance_token)) > 0);
--   ALTER TABLE public.whatsapp_instances
--     ALTER COLUMN instance_token SET NOT NULL;
--   COMMIT;
-- =====================================================================
