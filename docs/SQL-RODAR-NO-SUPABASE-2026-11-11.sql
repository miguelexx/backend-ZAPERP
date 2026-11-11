-- =====================================================================================
-- TUDO QUE TEM DE RODAR NO SUPABASE (SQL Editor) — trabalho de 10–11/11/2026
--
-- Regras do editor (medidas em 23–26/10): ele ENVOLVE o que você cola numa transação.
-- Por isso:
--   • CREATE INDEX CONCURRENTLY e VACUUM dão ERROR 25001 — use a forma indicada aqui
--     (CREATE INDEX comum; VACUUM colado SOZINHO numa aba, uma linha por vez).
--   • Lotes: rode o mesmo comando repetidas vezes até devolver 0 — a transação do editor
--     vira a transação do lote.
--   • Nunca cole BEGIN/COMMIT.
--
-- ORDEM:
--   BLOCO A  — obrigatório ANTES do deploy do backend (coluna tem_mensagem)
--   BLOCO B  — VACUUM (barato, sem lock de escrita; pode ser já)
--   BLOCO C  — evidência dos índices mortos (só leitura) → DROPs um a um, só com evidência
--   BLOCO D  — retenção de webhook_logs (conferir estado → limpar em lotes → agendar)
-- Cada "-- ▶" é um comando para colar sozinho.
-- =====================================================================================


-- =====================================================================================
-- BLOCO A — conversas.tem_mensagem (contadores exatos acima de 2000 conversas)
-- Migration: supabase/migrations/20261111135500_conversas_tem_mensagem.sql
-- O código já tolera a coluna ausente (cai no caminho antigo e avisa 1x no log), mas só
-- conta certo com A1–A3 aplicados. Rodar ANTES do deploy.
-- =====================================================================================

-- ▶ A0) conferência: a coluna já existe? (0 linhas = não existe ainda)
SELECT column_name, data_type, column_default
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'conversas' AND column_name = 'tem_mensagem';

-- ▶ A1) coluna (default false: nenhuma linha passa a contar por acidente)
ALTER TABLE public.conversas
  ADD COLUMN IF NOT EXISTS tem_mensagem boolean NOT NULL DEFAULT false;

-- ▶ A2) backfill em LOTES de 5000 — REPETIR este comando até devolver "UPDATE 0"
--       (31.849 conversas ≈ 7 rodadas). SKIP LOCKED pula o que o webhook estiver tocando.
WITH alvo AS (
  SELECT c.id
    FROM public.conversas c
   WHERE c.tem_mensagem = false
     AND EXISTS (SELECT 1 FROM public.mensagens m WHERE m.conversa_id = c.id)
   LIMIT 5000
   FOR UPDATE SKIP LOCKED
)
UPDATE public.conversas c
   SET tem_mensagem = true
  FROM alvo
 WHERE c.id = alvo.id;

-- ▶ A2-conferência) tem de devolver 0 antes do A3
SELECT count(*) AS faltam
  FROM public.conversas c
 WHERE c.tem_mensagem = false
   AND EXISTS (SELECT 1 FROM public.mensagens m WHERE m.conversa_id = c.id);

-- ▶ A3) trigger (cobre webhook, envio, import e sync; condicional = sem UPDATE morto)
CREATE OR REPLACE FUNCTION public.conversas_marcar_tem_mensagem()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.conversas
     SET tem_mensagem = true
   WHERE id = NEW.conversa_id
     AND company_id = NEW.company_id
     AND tem_mensagem = false;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_conversas_tem_mensagem ON public.mensagens;
CREATE TRIGGER trg_conversas_tem_mensagem
  AFTER INSERT ON public.mensagens
  FOR EACH ROW EXECUTE FUNCTION public.conversas_marcar_tem_mensagem();

-- ▶ A4) índice parcial — forma COMUM (o editor não aceita CONCURRENTLY). Lock SHARE:
--       leitura segue, escrita espera milissegundos (~32 mil linhas). Fora do pico.
--       lock_timeout evita ficar preso atrás de um UPDATE longo: se falhar, repita.
SET lock_timeout = '5s';
CREATE INDEX IF NOT EXISTS idx_conversas_company_tem_mensagem
  ON public.conversas (company_id, ultima_atividade DESC NULLS LAST, id DESC)
  WHERE tem_mensagem = true;

-- ▶ A4-conferência) tem de ser indisvalid = true
SELECT indexrelid::regclass, indisvalid
  FROM pg_index
 WHERE indexrelid = 'public.idx_conversas_company_tem_mensagem'::regclass;

-- ▶ A5) prova final: o contador novo bate com o antigo (mesma empresa)
SELECT
  (SELECT count(*) FROM public.conversas WHERE company_id = 1 AND tem_mensagem = true) AS com_flag,
  (SELECT count(*) FROM public.conversas c WHERE c.company_id = 1
     AND EXISTS (SELECT 1 FROM public.mensagens m WHERE m.conversa_id = c.id))        AS com_exists;
-- esperado: os dois números iguais


-- =====================================================================================
-- BLOCO B — estatísticas + visibility map (planning era 15× a execução)
--
-- VACUUM NÃO RODA NO SQL EDITOR (confirmado em 11/11/2026: "25001: VACUUM cannot run inside
-- a transaction block" mesmo colado sozinho — o editor sempre abre transação). Só roda via
-- psql/CLI com a connection string do projeto. Então, no editor, fazemos as duas coisas
-- que o VACUUM faria, pelos meios que o editor aceita:
--   • ANALYZE: estatísticas do planejador (é o que derruba o Planning Time). Aceito em transação.
--   • autovacuum mais agressivo nessas tabelas: o VACUUM (visibility map, Heap Fetches) passa
--     a ser feito pelo próprio Postgres logo após este comando e sempre que ~2% das linhas
--     mudarem (o padrão é 20% — em `conversas`, que leva UPDATE a cada mensagem, demorava).
-- =====================================================================================

-- ▶ B1) estatísticas agora (um comando, pode colar os quatro juntos)
ANALYZE public.conversas;
ANALYZE public.atendimentos;
ANALYZE public.conversa_unreads;
ANALYZE public.mensagens;

-- ▶ B2) autovacuum agressivo nas tabelas quentes (só metadado; sem lock relevante)
ALTER TABLE public.conversas       SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE public.atendimentos    SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE public.conversa_unreads SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.05);
ALTER TABLE public.mensagens       SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.05);

-- ▶ B3) conferência (rode de novo em algumas horas): last_autovacuum tem de avançar e
--       n_dead_tup cair — é a prova de que o VACUUM aconteceu sem você.
SELECT relname, n_live_tup, n_dead_tup, last_vacuum, last_autovacuum, last_analyze, last_autoanalyze
  FROM pg_stat_user_tables
 WHERE relname IN ('conversas', 'atendimentos', 'conversa_unreads', 'mensagens')
 ORDER BY relname;

-- (Só se um dia quiser o VACUUM manual mesmo: psql "<connection string do projeto>" -c
--  "VACUUM (ANALYZE) public.conversas;" — fora do editor. Nunca VACUUM FULL.)

-- ▶ B4) conferência do plano: Planning Time abaixo dos 4,1 ms medidos; Heap Fetches cai
--       depois do primeiro autovacuum (ver B3)
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, ultima_atividade
  FROM public.conversas
 WHERE company_id = 1 AND status_atendimento = 'aberta'
 ORDER BY ultima_atividade DESC NULLS LAST, id DESC
 LIMIT 40;


-- =====================================================================================
-- BLOCO C — índices mortos em `conversas` (cada UPDATE de ultima_atividade mantém ~35)
-- Passo 1 é SÓ LEITURA. Só dropar com idx_scan = 0 E estatísticas acumuladas há dias.
-- =====================================================================================

-- ▶ C1) desde quando as estatísticas acumulam (idx_scan = 0 só vale com dias de tráfego)
SELECT stats_reset FROM pg_stat_database WHERE datname = current_database();

-- ▶ C2) uso de cada índice de conversas (os de idx_scan = 0 no topo)
SELECT indexrelname, idx_scan,
       pg_size_pretty(pg_relation_size(indexrelid)) AS tamanho
  FROM pg_stat_user_indexes
 WHERE relname = 'conversas'
 ORDER BY idx_scan ASC, pg_relation_size(indexrelid) DESC;

-- ▶ C3) o índice NULLS LAST assumiu o lugar do antigo?
SELECT indexrelname, idx_scan
  FROM pg_stat_user_indexes
 WHERE indexrelname IN ('idx_conversas_company_atividade_id_nulls_last',
                        'idx_conversas_company_atividade_id');

-- ▶ C4) DROPs — UM POR VEZ, só depois de C1–C3 confirmarem idx_scan = 0 no índice em questão.
--       Nunca dropar índice que sustenta UNIQUE/PK. Repita C2 entre um e outro.
-- DROP INDEX IF EXISTS public.idx_conversas_company_atividade_id;      -- substituído pelo NULLS LAST (só se C3 mostrar 0 nele)
-- DROP INDEX IF EXISTS public.idx_conversa_atendentes_conversa_active; -- idêntico ao UNIQUE conversa_atendentes_active_unique
-- DROP INDEX IF EXISTS public.idx_clientes_company_telefone;           -- coberto pelo UNIQUE idx_clientes_company_telefone_unique
-- DROP INDEX IF EXISTS public.idx_mensagens_company_conversa;          -- prefixo de idx_mensagens_company_conversa_criado_id

-- Diagnósticos mais completos (redundâncias e índices sem uso em TODAS as tabelas):
--   supabase/migrations/20261025230000_indices_sem_uso_diagnostico.sql
--   supabase/migrations/20261025233000_indices_redundantes_diagnostico.sql


-- =====================================================================================
-- BLOCO D — retenção de webhook_logs (9 índices, 1 INSERT por webhook, ACK = 2-3× mensagens)
-- =====================================================================================

-- ▶ D1) estado real: o que existe com esse nome (esperado: 1 linha, tipo FUNCTION, retorno bigint)
SELECT p.oid,
       CASE p.prokind WHEN 'f' THEN 'FUNCTION' WHEN 'p' THEN 'PROCEDURE' ELSE p.prokind::text END AS tipo,
       pg_get_function_identity_arguments(p.oid) AS argumentos,
       pg_get_function_result(p.oid)             AS retorno,
       format('DROP %s public.%I(%s);',
              CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END,
              p.proname, pg_get_function_identity_arguments(p.oid)) AS comando_para_remover
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'webhook_logs_cleanup'
 ORDER BY p.prokind, p.oid;
-- Se aparecer uma PROCEDURE: copie o `comando_para_remover` DELA e rode só esse.
-- Se não aparecer nada: aplique supabase/migrations/20261026000000_webhook_logs_cleanup_corrige_procedure.sql
-- (é a FUNCTION que apaga UM lote e devolve a contagem).

-- ▶ D2) quanto há para limpar
SELECT count(*) AS total,
       count(*) FILTER (WHERE criado_em < now() - interval '30 days') AS mais_de_30_dias,
       pg_size_pretty(pg_total_relation_size('public.webhook_logs')) AS tamanho
  FROM public.webhook_logs;

-- ▶ D3) limpar em lotes — REPETIR até devolver 0 (cada chamada = 1 lote de 20000)
SELECT public.webhook_logs_cleanup(30, 20000);

-- ▶ D4) agendamento (opcional, 1 vez): pg_cron todo dia às 04:20
-- CREATE EXTENSION IF NOT EXISTS pg_cron;
-- SELECT cron.schedule('webhook-logs-retencao', '20 4 * * *',
--   $job$ SELECT public.webhook_logs_cleanup(30, 50000); $job$);
-- conferir: SELECT * FROM cron.job;


-- =====================================================================================
-- NÃO É DESTE TRABALHO (features de sessões anteriores, cada uma com a própria migration
-- e doc; só aplicar se for deployar a feature): visibilidade por número, comunidades,
-- orçamento WM 2A. Ver os docs correspondentes em docs/ai-handoff/.
-- =====================================================================================
