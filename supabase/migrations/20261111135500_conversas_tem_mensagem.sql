-- =====================================================================
-- conversas.tem_mensagem — "a conversa tem pelo menos uma mensagem?"
-- denormalizado em `conversas` (doc 40 §3.3, escrito em 11/11/2026).
--
-- ⚠️  NÃO APLICADA. Quem roda é o Miguel, no SQL Editor do Supabase.
--
-- POR QUÊ: os contadores de "Abertas", "Minha fila" e "Em atendimento"
-- (services/chatListCountsService.js, countConversasWithPostListRules)
-- precisavam saber se a conversa tem mensagem e esse dado só existia em
-- `mensagens`. Por isso varriam até CHAT_FILTER_ID_LIMIT (2000) linhas com
-- embed `mensagens(id)` e PARAVAM no teto — acima disso o número exibido é
-- menor que o real. A empresa 1 já tem 1524 conversas em "Todas". Com a
-- coluna, o contador volta a ser um count(*) exato, sem teto, e sem embed.
--
-- ═════════════════════════════════════════════════════════════════════
-- ORDEM OBRIGATÓRIA (anti-padrão 14: migration ANTES do deploy)
-- ═════════════════════════════════════════════════════════════════════
--   1) coluna              — rápido; pode ir junto com o 3 num mesmo run
--   2) backfill em lotes   — repetir o UPDATE até devolver "0 rows";
--                            conferir com a query de conferência
--   3) trigger             — só depois do backfill ter zerado
--   4) índice parcial      — SOZINHO num run (ver abaixo)
--   5) deploy do backend   — o código tolera a coluna ausente (cai no
--                            caminho antigo e avisa 1x no log), mas só
--                            conta certo com 1–3 aplicados
--
-- O QUE NÃO PODE ESTAR DENTRO DE BEGIN/COMMIT:
--   • `CREATE INDEX CONCURRENTLY` (passo 4a): o Postgres recusa com
--       ERROR 25001: CREATE INDEX CONCURRENTLY cannot run inside a
--                    transaction block
--     e o SQL Editor do Supabase ENVOLVE o que você cola numa transação
--     (medido em 23/10/2026, migration 20261023180000 — não adianta tirar
--     o BEGIN/COMMIT do texto, o wrapper é do editor). Portanto: cole o
--     passo 4a SOZINHO; se o editor ainda recusar, use o 4b (CREATE INDEX
--     comum). Com ~32 mil linhas o índice comum leva milissegundos e o
--     lock de escrita é imperceptível.
--   • O backfill (passo 2) também NÃO deve ir num BEGIN/COMMIT único com
--     todos os lotes: a graça do lote é soltar o lock entre um e outro.
--     Rode o UPDATE como um comando por vez, quantas vezes precisar.
--
-- A coluna NUNCA volta para false (apagar/limpar mensagens não é coberto).
-- Se um dia isso importar, o trigger precisa de um par em AFTER DELETE.
-- =====================================================================


-- ─────────────────────────────────────────────────────────────────────
-- 1) COLUNA — default false: nenhuma linha existente passa a contar
--    por acidente; o backfill é quem liga.
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.conversas
  ADD COLUMN IF NOT EXISTS tem_mensagem boolean NOT NULL DEFAULT false;


-- ─────────────────────────────────────────────────────────────────────
-- 2) BACKFILL EM LOTES — NÃO fazer num UPDATE único: 31.849 conversas ×
--    subquery em `mensagens` prende a tabela inteira enquanto roda.
--    Rode este comando repetidamente até devolver "UPDATE 0".
--    `FOR UPDATE SKIP LOCKED` pula linhas que o webhook/envio estiver
--    atualizando naquele instante (elas entram no lote seguinte).
-- ─────────────────────────────────────────────────────────────────────
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

-- Conferência: tem de devolver 0 antes de seguir para o passo 3.
SELECT count(*) AS faltam
  FROM public.conversas c
 WHERE c.tem_mensagem = false
   AND EXISTS (SELECT 1 FROM public.mensagens m WHERE m.conversa_id = c.id);


-- ─────────────────────────────────────────────────────────────────────
-- 3) TRIGGER — cobre webhook, envio, import e sync de uma vez (não dá
--    para confiar em acertar todos os caminhos no código — são muitos).
--    Condicional (`AND tem_mensagem = false`): depois da 1ª mensagem não
--    há UPDATE morto em `conversas` a cada mensagem nova.
-- ─────────────────────────────────────────────────────────────────────
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


-- ─────────────────────────────────────────────────────────────────────
-- 4) ÍNDICE PARCIAL para as abas que exigem mensagem. Mesma ordenação da
--    lista (ultima_atividade DESC NULLS LAST, id DESC — ver migration
--    20261023180000) para o planner poder usá-lo também na listagem.
--
-- 4a) SEM bloqueio de escrita — tem de rodar SOZINHO, fora de transação
--     (psql / Supabase CLI, ou o SQL Editor se ele aceitar 1 comando só).
-- ─────────────────────────────────────────────────────────────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversas_company_tem_mensagem
  ON public.conversas (company_id, ultima_atividade DESC NULLS LAST, id DESC)
  WHERE tem_mensagem = true;

-- 4b) Se o 4a falhar com "25001 ... cannot run inside a transaction block",
--     use esta versão (lock SHARE: leitura segue, escrita espera — com
--     ~32 mil linhas, milissegundos). Só uma das duas; IF NOT EXISTS evita
--     duplicar se o 4a tiver chegado a criar.
-- CREATE INDEX IF NOT EXISTS idx_conversas_company_tem_mensagem
--   ON public.conversas (company_id, ultima_atividade DESC NULLS LAST, id DESC)
--   WHERE tem_mensagem = true;

-- Conferência do índice (tem de estar `indisvalid = true`; se o 4a foi
-- interrompido no meio, fica um índice INVÁLIDO que precisa de DROP):
-- SELECT indexrelid::regclass, indisvalid
--   FROM pg_index WHERE indexrelid = 'public.idx_conversas_company_tem_mensagem'::regclass;
