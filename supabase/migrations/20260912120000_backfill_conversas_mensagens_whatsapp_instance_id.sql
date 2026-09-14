-- Backfill: carimba conversas/mensagens legadas (whatsapp_instance_id NULL) com a
-- ÚNICA instância ativa da empresa. Pré-requisito para ativar 2+ números por empresa.
-- Ver docs/ai-handoff/28-MULTIPLOS-NUMEROS-WHAPI.md (§5 risco #1, §7 Etapa 3).
--
-- POR QUE: o inbound casa conversa por "instância = X OU instância NULL" (compat. legado,
-- applyWhatsappInstanceFilterOrLegacy). Enquanto a empresa tem 1 número, NULL é inofensivo;
-- ao ganhar o 2º número, uma mensagem do número B pode cair numa conversa NULL que era do A
-- e a resposta sair pelo canal errado. Carimbar antes elimina o risco.
--
-- SEGURANÇA:
--  * Só age em empresas com EXATAMENTE 1 instância ativa (alvo inequívoco).
--  * Conflict-safe: PULA linhas cujo (company, instância, telefone|chat_lid) já existe carimbado
--    (evita violar idx_conversas_company_instance_telefone_unique / _chat_lid_unique).
--    Diagnóstico 2026-09-12: 59 conversas em conflito de telefone (duplicatas legadas) — ficam
--    NULL para revisão manual/merge; 0 conflitos de chat_lid.
--  * Idempotente: rodar de novo não muda nada (só toca linhas ainda NULL).
--  * Não apaga nem mescla dados. Não altera schema.
--
-- NÃO aplicar sem autorização. Aplicar ANTES de habilitar o 2º número de qualquer empresa.
-- Em base grande a transação pode demorar alguns segundos (14k conversas + suas mensagens).

BEGIN;

-- Empresas com exatamente 1 instância ativa → (company_id, alvo_instance_id).
WITH alvo AS (
  SELECT company_id, min(id) FILTER (WHERE ativo) AS alvo_instance_id
  FROM public.whatsapp_instances
  GROUP BY company_id
  HAVING count(*) FILTER (WHERE ativo) = 1
)
UPDATE public.conversas c
SET whatsapp_instance_id = a.alvo_instance_id
FROM alvo a
WHERE c.company_id = a.company_id
  AND c.whatsapp_instance_id IS NULL
  -- pula qualquer linha que colidiria com o índice único por telefone OU chat_lid
  AND NOT EXISTS (
    SELECT 1 FROM public.conversas c2
    WHERE c2.company_id = c.company_id
      AND c2.whatsapp_instance_id = a.alvo_instance_id
      AND c2.id <> c.id
      AND (
        (c.telefone IS NOT NULL AND btrim(c.telefone) <> '' AND c2.telefone = c.telefone)
        OR
        (c.chat_lid IS NOT NULL AND btrim(c.chat_lid) <> '' AND c2.chat_lid = c.chat_lid)
      )
  );

-- Mensagens: carimba com a instância JÁ resolvida da sua conversa (consistência conversa↔mensagem).
-- Só toca mensagens NULL de conversas que ficaram carimbadas acima.
-- Conflict-safe: pula se já existir mensagem com mesmo (company, instância, whatsapp_id).
UPDATE public.mensagens m
SET whatsapp_instance_id = c.whatsapp_instance_id
FROM public.conversas c
WHERE m.conversa_id = c.id
  AND m.company_id = c.company_id
  AND c.whatsapp_instance_id IS NOT NULL
  AND m.whatsapp_instance_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.mensagens m2
    WHERE m2.company_id = m.company_id
      AND m2.whatsapp_instance_id = c.whatsapp_instance_id
      AND m2.whatsapp_id IS NOT NULL AND m2.whatsapp_id <> ''
      AND m2.whatsapp_id = m.whatsapp_id
      AND m2.id <> m.id
  );

-- Relatório (aparece em "Messages"/NOTICE; não altera dados).
DO $$
DECLARE
  conv_null_restante bigint;
  msg_null_restante  bigint;
BEGIN
  SELECT count(*) INTO conv_null_restante FROM public.conversas WHERE whatsapp_instance_id IS NULL;
  SELECT count(*) INTO msg_null_restante  FROM public.mensagens  WHERE whatsapp_instance_id IS NULL;
  RAISE NOTICE 'Backfill concluido. Conversas ainda NULL (conflitos/sem alvo): %; Mensagens ainda NULL: %',
    conv_null_restante, msg_null_restante;
END $$;

COMMIT;
