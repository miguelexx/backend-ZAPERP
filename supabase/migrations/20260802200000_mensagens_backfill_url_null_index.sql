-- Índice parcial para o sweep global de backfill de mídia (inboundMediaBackfillService).
-- A varredura periódica busca mensagens de mídia SEM URL para reparar (áudio/imagem/doc cujo link
-- só chega depois): `.in('tipo', [...]).is('url', null).gte('criado_em', X).order(criado_em desc)`.
-- Sem índice, isso vira seq scan da tabela inteira de mensagens a cada ciclo do sweep, entre todos
-- os tenants. O predicado `WHERE url IS NULL` é altamente seletivo (a esmagadora maioria das linhas
-- tem URL ou é texto), então o índice parcial fica pequeno e o planner varre só as pendências
-- recentes já ordenadas por criado_em.
--
-- Apenas apoia leitura; não altera dados, tipos nem regras de atendimento.
-- Obs.: em base muito grande, considerar recriar como CREATE INDEX CONCURRENTLY (fora de transação)
-- para não bloquear escrita durante a construção; a forma simples abaixo segue a convenção do repo.

CREATE INDEX IF NOT EXISTS idx_mensagens_backfill_url_null
  ON public.mensagens (criado_em DESC)
  WHERE url IS NULL;
