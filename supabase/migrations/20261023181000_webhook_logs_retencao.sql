-- =====================================================================
-- Retenção de `webhook_logs`
--
-- Proposto em docs/ai-handoff/29-AUDITORIA-PERFORMANCE-BACKEND.md §backlog
-- item 8. Reverificado em 23/10/2026: existe `mediaRetentionService` para
-- mídia, mas NADA limpa esta tabela.
--
-- ─────────────────────────────────────────────────────────────────────
-- POR QUE DÓI
-- ─────────────────────────────────────────────────────────────────────
-- `webhook_logs` leva 1 INSERT por webhook recebido, e os ACKs de status
-- são 2-3× o volume de mensagens. A tabela tem NOVE índices:
--
--   provider · company · instance · criado · status · event_type
--   company_criado_id · provider_status_criado · whatsapp_instance_id
--
-- Cada INSERT mantém os nove. Sem retenção, a tabela só cresce: o custo
-- de escrita de todo webhook sobe junto, e o espaço nunca volta.
--
-- ═════════════════════════════════════════════════════════════════════
-- POR QUE É UM LOTE POR CHAMADA (e não um loop interno)
-- ═════════════════════════════════════════════════════════════════════
-- O caminho óbvio seria um loop com COMMIT a cada lote. Não dá, aqui:
--
--   • FUNCTION PL/pgSQL roda inteira em UMA transação — "lotes" dentro
--     dela não commitam nada e os locks ficam presos até o fim;
--   • PROCEDURE pode dar COMMIT no meio, mas **o SQL Editor do Supabase
--     envolve o que você cola numa transação**, e aí o COMMIT é recusado.
--     É a mesma razão pela qual CREATE INDEX CONCURRENTLY falha ali com
--     `25001: cannot run inside a transaction block` — medido em 23/10.
--
-- Então a função apaga **UM lote e retorna**. A transação do próprio
-- editor vira a transação do lote: curta, com os locks liberados ao fim
-- de cada execução. Você chama de novo até devolver 0.
--
-- Usa o índice `idx_webhook_logs_criado` (criado_em DESC), que já existe.
-- =====================================================================

-- Um rascunho anterior pode ter criado PROCEDURE/FUNCTION com este nome;
-- sem isto, o CREATE OR REPLACE falha com "cannot change routine kind".
DROP PROCEDURE IF EXISTS public.webhook_logs_cleanup(integer, integer, integer);
DROP FUNCTION  IF EXISTS public.webhook_logs_cleanup(integer, integer, integer);
DROP FUNCTION  IF EXISTS public.webhook_logs_cleanup(integer, integer);

CREATE OR REPLACE FUNCTION public.webhook_logs_cleanup(
  dias          integer DEFAULT 30,
  tamanho_lote  integer DEFAULT 20000
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  corte     timestamptz := now() - make_interval(days => GREATEST(dias, 1));
  apagadas  bigint;
BEGIN
  WITH alvo AS (
    SELECT id
      FROM public.webhook_logs
     WHERE criado_em < corte
     ORDER BY criado_em
     LIMIT GREATEST(tamanho_lote, 1)
     FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.webhook_logs w
   USING alvo
   WHERE w.id = alvo.id;

  GET DIAGNOSTICS apagadas = ROW_COUNT;
  RETURN apagadas;
END;
$$;

COMMENT ON FUNCTION public.webhook_logs_cleanup(integer, integer) IS
  'Apaga UM lote de webhook_logs mais antigos que N dias e devolve quantas linhas apagou. Chamar repetidamente ate devolver 0. Ver migration 20261023181000.';


-- =====================================================================
-- COMO USAR
-- =====================================================================
--
-- ── Passo 1: ver o tamanho do problema (só leitura) ───────────────────
--
--   SELECT count(*) AS total,
--          count(*) FILTER (WHERE criado_em < now() - interval '30 days') AS fora_da_janela,
--          min(criado_em) AS mais_antigo,
--          pg_size_pretty(pg_total_relation_size('public.webhook_logs')) AS tamanho
--     FROM public.webhook_logs;
--
-- ── Passo 2: limpar, um lote por execução ─────────────────────────────
--
--   SELECT public.webhook_logs_cleanup(30);
--
-- Devolve quantas apagou (até 20.000). **Rode de novo até devolver 0.**
-- Se `fora_da_janela` for muito grande, dá para apertar o lote:
--
--   SELECT public.webhook_logs_cleanup(30, 50000);
--
-- (Lote maior = menos execuções, porém transação mais longa. 20.000 é um
--  meio-termo que costuma levar poucos segundos mesmo com nove índices.)
--
-- ── Passo 3: devolver o espaço ────────────────────────────────────────
-- DELETE marca as linhas como mortas; o arquivo não encolhe sozinho.
-- Depois da primeira limpeza grande, UMA vez:
--
--   VACUUM (ANALYZE) public.webhook_logs;
--
-- (`VACUUM FULL` devolveria o espaço ao sistema operativo, mas BLOQUEIA a
--  tabela inteira — não use em horário de movimento.)
--
-- ── Passo 4 (opcional): agendar o diário ──────────────────────────────
-- Depois da primeira limpeza, o volume diário é pequeno e cabe num lote.
-- Com pg_cron habilitado:
--
--   CREATE EXTENSION IF NOT EXISTS pg_cron;
--
--   SELECT cron.schedule(
--     'webhook-logs-retencao',
--     '20 4 * * *',                                   -- 04:20 todo dia
--     $job$ SELECT public.webhook_logs_cleanup(30, 50000); $job$
--   );
--
--   -- conferir:   SELECT * FROM cron.job;
--   -- desagendar: SELECT cron.unschedule('webhook-logs-retencao');
--
-- Sem pg_cron, chame manualmente de tempos em tempos.
--
-- ── Quantos dias guardar? ─────────────────────────────────────────────
-- 30 é o padrão daqui. Para diagnóstico de incidente, 7 costuma bastar e
-- deixa a tabela bem menor: `SELECT public.webhook_logs_cleanup(7);`
--
-- =====================================================================
-- APÊNDICE — loop automático (psql / Supabase CLI, NÃO no SQL Editor)
-- =====================================================================
-- Fora do editor não há wrapper de transação, então dá para varrer tudo
-- de uma vez, com COMMIT por lote:
--
--   DO $$
--   DECLARE n bigint;
--   BEGIN
--     LOOP
--       SELECT public.webhook_logs_cleanup(30, 20000) INTO n;
--       COMMIT;
--       EXIT WHEN n = 0;
--     END LOOP;
--   END $$;
-- =====================================================================
