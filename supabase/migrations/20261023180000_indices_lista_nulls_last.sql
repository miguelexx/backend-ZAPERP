-- =====================================================================
-- Índices da LISTA DE CONVERSAS (GET /chats e /chats/counts)
--
-- Proposto em docs/ai-handoff/29-AUDITORIA-PERFORMANCE-BACKEND.md §3 em
-- 29/09/2026 e nunca escrito como migration. Reverificado em 23/10/2026.
--
-- ─────────────────────────────────────────────────────────────────────
-- 1) O índice de ordenação da lista NÃO ERA ELEGÍVEL
-- ─────────────────────────────────────────────────────────────────────
-- A lista ordena assim (controllers/chat/conversationListController.js:675,
-- 687 e 700 — os três caminhos: completo, mínimo e bare):
--
--     .order('ultima_atividade', { ascending: false, nullsFirst: false })
--     .order('id',               { ascending: false })
--   → ORDER BY ultima_atividade DESC NULLS LAST, id DESC
--
-- E o índice existente é:
--
--     idx_conversas_company_atividade_id
--       ON conversas (company_id, ultima_atividade DESC, id DESC)
--
-- Em Postgres, `DESC` implica **NULLS FIRST**. Ordenação pedindo NULLS LAST
-- não casa com um índice NULLS FIRST, então o planner ignora o índice e
-- ORDENA O CONJUNTO FILTRADO INTEIRO a cada página.
--
-- O parcial `idx_conversas_company_ultima_atividade` até é NULLS LAST, mas
-- tem `WHERE status_atendimento != 'fechada'` e por isso também não serve
-- às abas que incluem conversas fechadas.
--
-- 2) `atendimentos` não tinha índice começando por usuário. Todo GET /chats
--    e /chats/counts de NÃO-ADMIN consulta por `de_usuario_id`/`para_usuario_id`
--    com `acao = 'transferiu'` (regra "conversas que eu transferi aparecem
--    independente do setor"). Sem índice, é varredura.
--
-- 3) `conversa_unreads` é sempre lida só nas linhas com contagem > 0; o
--    índice parcial deixa de indexar as zeradas, que são a maioria.
--
-- ═════════════════════════════════════════════════════════════════════
-- ⚠️  SOBRE `CONCURRENTLY` — LEIA ANTES DE COLAR
-- ═════════════════════════════════════════════════════════════════════
-- Uma versão anterior deste arquivo usava CREATE INDEX CONCURRENTLY.
-- **Não funciona no SQL Editor do Supabase**: ele envolve o que você cola
-- numa transação, e o Postgres recusa com
--
--     ERROR: 25001: CREATE INDEX CONCURRENTLY cannot run inside a
--                   transaction block
--
-- (Medido em 23/10/2026. Não adianta tirar o BEGIN/COMMIT: o wrapper é do
--  editor, não do SQL colado.) O erro aborta antes de criar nada — não
-- deixa índice inválido.
--
-- Então este arquivo usa **CREATE INDEX comum**, que o editor aceita.
--
-- O QUE ISSO CUSTA: CREATE INDEX comum pega lock `SHARE` na tabela.
--   • LEITURA continua: a lista de conversas segue abrindo normalmente.
--   • ESCRITA fica bloqueada: INSERT/UPDATE em `conversas` esperam — ou
--     seja, **mensagem que chegar nesse intervalo fica na fila** até o
--     índice terminar.
--
-- Por isso: rode o passo 0 primeiro para saber quanto tempo isso leva, e
-- faça fora do horário de pico.
--
-- Se um dia tiver acesso via `psql` ou Supabase CLI (aí não há wrapper de
-- transação), a versão sem bloqueio é a mesma linha com CONCURRENTLY —
-- está no rodapé deste arquivo.
-- =====================================================================


-- ─────────────────────────────────────────────────────────────────────
-- TAMANHOS MEDIDOS EM 23/10/2026 (produção)
-- ─────────────────────────────────────────────────────────────────────
--   conversas         31.849 linhas   131 MB
--   atendimentos      92.946 linhas    36 MB
--   conversa_unreads 129.487 linhas    38 MB
--
-- Com 32 mil linhas, o índice de `conversas` é criado em milissegundos —
-- o bloqueio de escrita é imperceptível. **Não precisa de janela calma.**
--
-- E os números REORDENAM a prioridade: o ganho maior aqui não é o NULLS
-- LAST (ordenar ~32 mil linhas já é barato), e sim os índices 2 e 3 —
-- `atendimentos` tem 92.946 linhas e é consultada **em todo GET /chats de
-- não-admin** por (company_id, de_usuario_id/para_usuario_id, acao), hoje
-- sem índice nenhum por essas colunas. Mesma história em `conversa_unreads`
-- (129.487 linhas, lida por company_id+usuario_id+unread_count>0 a cada
-- requisição). O NULLS LAST vale como seguro para quando a base crescer.
--
-- ─────────────────────────────────────────────────────────────────────
-- PASSO 0 — DIMENSIONAR (se um dia quiser repetir a medição)
-- ─────────────────────────────────────────────────────────────────────
-- Regra de bolso: índice B-tree sai a ~1 milhão de linhas por poucos
-- segundos. Até ~500 mil linhas em `conversas`, o bloqueio é de segundos.
--
--   SELECT 'conversas' AS tabela, count(*) AS linhas,
--          pg_size_pretty(pg_total_relation_size('public.conversas')) AS tamanho
--     FROM public.conversas
--   UNION ALL
--   SELECT 'atendimentos', count(*),
--          pg_size_pretty(pg_total_relation_size('public.atendimentos'))
--     FROM public.atendimentos
--   UNION ALL
--   SELECT 'conversa_unreads', count(*),
--          pg_size_pretty(pg_total_relation_size('public.conversa_unreads'))
--     FROM public.conversa_unreads;
--
-- `atendimentos` e `conversa_unreads` são pequenas por natureza — os
-- índices 2, 3 e 4 abaixo são seguros em qualquer cenário.
-- O único que merece cuidado é o índice 1, em `conversas`.


-- ─────────────────────────────────────────────────────────────────────
-- PASSO 1 — o índice principal (o que precisa de janela calma)
-- ─────────────────────────────────────────────────────────────────────
-- `lock_timeout` evita ficar preso atrás de uma transação longa de outra
-- pessoa: se não conseguir o lock em 5 s, falha limpo e você tenta depois.
SET lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS idx_conversas_company_atividade_id_nulls_last
  ON public.conversas (company_id, ultima_atividade DESC NULLS LAST, id DESC);

RESET lock_timeout;


-- ─────────────────────────────────────────────────────────────────────
-- PASSO 2 — os três pequenos (pode rodar junto, a qualquer hora)
-- ─────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_atendimentos_company_de_usuario_transferiu
  ON public.atendimentos (company_id, de_usuario_id, criado_em DESC)
  WHERE acao = 'transferiu';

CREATE INDEX IF NOT EXISTS idx_atendimentos_company_para_usuario_transferiu
  ON public.atendimentos (company_id, para_usuario_id, criado_em DESC)
  WHERE acao = 'transferiu';

CREATE INDEX IF NOT EXISTS idx_conversa_unreads_company_usuario_positive
  ON public.conversa_unreads (company_id, usuario_id, conversa_id)
  WHERE unread_count > 0;


-- =====================================================================
-- APLICADO E CONFIRMADO EM PRODUÇÃO — 23/10/2026
-- =====================================================================
-- Os quatro criados, todos `indisvalid = true`. Planos medidos:
--
--   atendimentos      Index Scan        2 buffers   exec 0,136 ms
--   conversa_unreads  Index Scan        6 buffers   exec 0,115 ms
--   conversas         Index ONLY Scan  30 buffers   exec 0,278 ms
--
-- O de `conversas` surpreendeu: com 32 mil linhas eu previa que o planner
-- preferisse Seq Scan, e ele escolheu Index Only Scan.
--
-- ⚠️  MAS OS PLANOS REVELARAM OUTRA COISA — ver "custo de PLANNING" abaixo.
--
-- =====================================================================
-- CONFERIR DEPOIS (rodar à parte)
-- =====================================================================
--
-- a) Os quatro existem e estão válidos:
--
--   SELECT indexrelid::regclass AS indice, indisvalid
--     FROM pg_index
--    WHERE indexrelid::regclass::text IN (
--            'idx_conversas_company_atividade_id_nulls_last',
--            'idx_atendimentos_company_de_usuario_transferiu',
--            'idx_atendimentos_company_para_usuario_transferiu',
--            'idx_conversa_unreads_company_usuario_positive');
--   -- esperado: 4 linhas, todas indisvalid = true
--
-- b) O planner parou de ordenar tudo (troque 1 pelo company_id real):
--
--   EXPLAIN (ANALYZE, BUFFERS)
--   SELECT id FROM public.conversas
--    WHERE company_id = 1
--    ORDER BY ultima_atividade DESC NULLS LAST, id DESC
--    LIMIT 40;
--   -- antes:  "Sort" + "Seq Scan"/"Bitmap"
--   -- depois: "Index Scan using idx_conversas_company_atividade_id_nulls_last"
--
-- b2) O índice de unreads também entrou (troque 1/1 por valores reais):
--
--   EXPLAIN (ANALYZE, BUFFERS)
--   SELECT conversa_id, unread_count FROM public.conversa_unreads
--    WHERE company_id = 1 AND usuario_id = 1 AND unread_count > 0;
--   -- esperado: "Index Scan using idx_conversa_unreads_company_usuario_positive"
--
-- b3) ATENÇÃO ao índice de `conversas`: com ~32 mil linhas o planner PODE
--     preferir Seq Scan mesmo com o índice disponível — e estaria certo,
--     porque ordenar 32 mil linhas é barato. Se (b) mostrar Seq Scan, NÃO
--     é erro: o índice fica como seguro para quando a base crescer.
--     O que não pode acontecer é ele aparecer como inválido em (a).
--
-- c) Depois de alguns dias de tráfego, ver se o novo é usado:
--
--   SELECT indexrelname, idx_scan
--     FROM pg_stat_user_indexes
--    WHERE indexrelname IN ('idx_conversas_company_atividade_id_nulls_last',
--                           'idx_conversas_company_atividade_id');
--
-- =====================================================================
-- SÓ DEPOIS DE (c) CONFIRMAR USO — limpeza (NÃO rodar agora)
-- =====================================================================
-- Cada UPDATE de `conversas.ultima_atividade` (ou seja, TODA mensagem)
-- mantém ~35 índices. O antigo vira redundante:
--
--   DROP INDEX IF EXISTS public.idx_conversas_company_atividade_id;
--
-- Comentado de propósito: só remova depois de ver `idx_scan` parado nele
-- e subindo no novo.
--
-- =====================================================================
-- APÊNDICE — versão sem bloqueio (psql / Supabase CLI, NÃO no SQL Editor)
-- =====================================================================
-- Fora do editor não existe o wrapper de transação, então dá para usar
-- CONCURRENTLY e não bloquear escrita nenhuma. Um comando por vez:
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversas_company_atividade_id_nulls_last
--     ON public.conversas (company_id, ultima_atividade DESC NULLS LAST, id DESC);
--
-- Se um CONCURRENTLY falhar no meio, deixa índice INVALID:
--   SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
--   DROP INDEX CONCURRENTLY IF EXISTS public.<nome>;
-- =====================================================================


-- =====================================================================
-- ACHADO NOVO (23/10) — o custo agora é o PLANNING, não a execução
-- =====================================================================
-- Nos três EXPLAIN, o tempo de planejamento passou MUITO o de execução:
--
--   atendimentos      planning 1,440 ms  ×  exec 0,136 ms   (10×)
--   conversa_unreads  planning 0,923 ms  ×  exec 0,115 ms    (8×)
--   conversas         planning 4,111 ms  ×  exec 0,278 ms   (15×)
--                     buffers de planejamento: hit 1080 read 49
--
-- 4 ms de planejamento em TODA consulta a `conversas`. A causa é o número
-- de índices da tabela (~35, conforme doc 29 §3): o planner avalia todos
-- antes de escolher. Isto agora é o maior custo dessa query — maior que
-- ler os dados.
--
-- DOIS PASSOS, nesta ordem:
--
-- 1) `Heap Fetches: 29` no Index Only Scan mostra que o visibility map não
--    está em dia — ele ainda foi ao heap 29 vezes. Barato e seguro:
--
--      VACUUM (ANALYZE) public.conversas;
--
-- 2) Juntar evidência para dropar índice morto (rodar daqui a alguns dias,
--    com tráfego real acumulado):
--
--      SELECT indexrelname, idx_scan,
--             pg_size_pretty(pg_relation_size(indexrelid)) AS tamanho
--        FROM pg_stat_user_indexes
--       WHERE relname = 'conversas'
--       ORDER BY idx_scan ASC, pg_relation_size(indexrelid) DESC;
--
--    `idx_scan = 0` depois de dias de uso = candidato a DROP. Cada índice
--    removido alivia o planning de TODA query e o custo de escrita de TODA
--    mensagem (o UPDATE de `ultima_atividade` mantém todos eles).
--    Começar pelo `idx_conversas_company_atividade_id`, já redundante.
--
--    NÃO dropar índice que sustenta UNIQUE/PK, nem os parciais de regra de
--    negócio, sem conferir o que os usa.
-- =====================================================================
