-- merge_conversas_null_duplicadas.sql
-- Resolve as duplicatas legadas que impedem o backfill de whatsapp_instance_id:
-- conversa com whatsapp_instance_id = NULL cujo (company_id, telefone) JA tem conversa
-- carimbada na unica instancia ativa da empresa (conflito do indice unico).
-- Diagnostico 2026-09-12: 59 pares (57 cascas vazias + 2 com historico na empresa 14).
-- Ver docs/ai-handoff/28-MULTIPLOS-NUMEROS-WHAPI.md (§5, §7, §11).
--
-- ESTRATEGIA (espelha helpers/conversationSync.mergeConversasIntoCanonico):
--  * PRESERVA historico: reaponta mensagens/atendimentos/historico/avaliacoes/bot_logs/guard_logs
--    da conversa NULL (duplicata) para a carimbada (canonica).
--  * DESCARTA estado por-conversa da duplicata (tags/prefs/unreads/atendentes) — a canonica ja tem o seu.
--  * departamento_grupos: reaponta se nao colidir; senao descarta a da duplicata.
--  * Remove as cascas NULL.
--
-- SEGURANCA: transacional (BEGIN/COMMIT) = tudo-ou-nada. Qualquer erro inesperado faz ROLLBACK
-- automatico, sem estado parcial. 1:1 garantido pelo indice unico. Idempotente (re-rodar nao acha pares).
-- Rodar em baixa demanda; conferir depois as 2 conversas ativas da empresa 14.
--
-- ORDEM: rodar ESTE merge ANTES do backfill 20260912120000 (depois do merge, o backfill carimba
-- as mensagens reapontadas junto com o resto).

BEGIN;

-- 1) Pares (duplicata NULL -> canonica). conversa_id e PK global, entao os filhos casam so por conversa_id.
CREATE TEMP TABLE _pares ON COMMIT DROP AS
WITH alvo AS (
  SELECT company_id, min(id) FILTER (WHERE ativo) AS instance_id
  FROM public.whatsapp_instances
  GROUP BY company_id
  HAVING count(*) FILTER (WHERE ativo) = 1
)
SELECT n.id AS null_id, c2.id AS canonical_id
FROM public.conversas n
JOIN alvo a  ON a.company_id = n.company_id
JOIN public.conversas c2
  ON c2.company_id = n.company_id
 AND c2.whatsapp_instance_id = a.instance_id
 AND c2.telefone = n.telefone
 AND c2.id <> n.id
WHERE n.whatsapp_instance_id IS NULL
  AND n.telefone IS NOT NULL AND btrim(n.telefone) <> '';

-- 2) PRESERVAR: reaponta para a canonica.
--    mensagens: remove antes as duplicadas reais (mesmo whatsapp_id ja presente na canonica).
DELETE FROM public.mensagens m USING _pares p
WHERE m.conversa_id = p.null_id
  AND m.whatsapp_id IS NOT NULL AND m.whatsapp_id <> ''
  AND EXISTS (SELECT 1 FROM public.mensagens m2
              WHERE m2.conversa_id = p.canonical_id AND m2.whatsapp_id = m.whatsapp_id);
UPDATE public.mensagens m SET conversa_id = p.canonical_id
FROM _pares p WHERE m.conversa_id = p.null_id;

UPDATE public.atendimentos a SET conversa_id = p.canonical_id
FROM _pares p WHERE a.conversa_id = p.null_id;

UPDATE public.historico_atendimentos h SET conversa_id = p.canonical_id
FROM _pares p WHERE h.conversa_id = p.null_id;

UPDATE public.avaliacoes_atendimento av SET conversa_id = p.canonical_id
FROM _pares p WHERE av.conversa_id = p.null_id;

UPDATE public.bot_logs b SET conversa_id = p.canonical_id
FROM _pares p WHERE b.conversa_id = p.null_id;

UPDATE public.whatsapp_envio_guard_logs g SET conversa_id = p.canonical_id
FROM _pares p WHERE g.conversa_id = p.null_id;

-- 3) departamento_grupos: reaponta o que nao colide; descarta o resto (canonica ja tem).
UPDATE public.departamento_grupos d SET conversa_id = p.canonical_id
FROM _pares p
WHERE d.conversa_id = p.null_id
  AND NOT EXISTS (
    SELECT 1 FROM public.departamento_grupos d2
    WHERE d2.company_id = d.company_id
      AND d2.departamento_id = d.departamento_id
      AND d2.conversa_id = p.canonical_id
  );
DELETE FROM public.departamento_grupos d USING _pares p WHERE d.conversa_id = p.null_id;

-- 4) Estado por-conversa da DUPLICATA (descartavel): apaga as linhas da NULL.
DELETE FROM public.conversa_tags t          USING _pares p WHERE t.conversa_id = p.null_id;
DELETE FROM public.conversa_usuario_prefs u USING _pares p WHERE u.conversa_id = p.null_id;
DELETE FROM public.conversa_unreads r       USING _pares p WHERE r.conversa_id = p.null_id;
DELETE FROM public.conversa_atendentes ca   USING _pares p WHERE ca.conversa_id = p.null_id;

-- 5) Remove as cascas NULL (sem filhos referenciando).
DELETE FROM public.conversas c USING _pares p WHERE c.id = p.null_id;

-- Relatorio (aparece em Messages).
DO $$
DECLARE n_pares bigint;
BEGIN
  GET DIAGNOSTICS n_pares = ROW_COUNT;
  RAISE NOTICE 'Merge concluido. Cascas NULL removidas: %', n_pares;
END $$;

COMMIT;
