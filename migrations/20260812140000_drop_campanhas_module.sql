-- =====================================================
-- Remove o modulo de Campanhas (disparo em massa), nao utilizado.
--
-- Verificado em 2026-08-12: campanhas e campanha_envios com 0 linhas e 0 escritas
-- ao longo da vida. Modulo autocontido (campanhaController/campanhaRoutes/
-- campanhaService); nenhum fluxo ativo (webhook/cron/job) dispara campanhas.
-- A unica referencia externa e o delete em cascata de clientes
-- (clienteController.excluirCliente/apagarTodosClientes), que ja ignora
-- erro "does not exist".
--
-- NAO confundir com opt-in/opt-out: contato_opt_in e contato_opt_out PERMANECEM
-- (usados no webhook de recebimento e na protecao anti-bloqueio).
--
-- DROP sem CASCADE: campanha_envios tem FK -> campanhas, por isso vem primeiro.
-- Codigo Node do modulo sera removido em sessao separada (ver docs/).
-- =====================================================

BEGIN;

DROP TABLE IF EXISTS public.campanha_envios;
DROP TABLE IF EXISTS public.campanhas;

COMMIT;
