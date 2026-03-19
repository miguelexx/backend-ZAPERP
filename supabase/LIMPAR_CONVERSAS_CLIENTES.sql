-- Limpa conversas, clientes e dependências (ordem correta por FKs)
-- Execute no Supabase SQL Editor

BEGIN;

-- 1) avaliacoes_atendimento referencia atendimentos — excluir primeiro
DELETE FROM public.avaliacoes_atendimento
WHERE atendimento_id IN (SELECT id FROM public.atendimentos);

-- 2) Dependências das conversas
DELETE FROM public.mensagens_ocultas
WHERE conversa_id IN (SELECT id FROM public.conversas);

DELETE FROM public.conversa_unreads
WHERE conversa_id IN (SELECT id FROM public.conversas);

DELETE FROM public.atendimentos
WHERE conversa_id IN (SELECT id FROM public.conversas);

DELETE FROM public.historico_atendimentos
WHERE conversa_id IN (SELECT id FROM public.conversas);

DELETE FROM public.conversa_tags
WHERE conversa_id IN (SELECT id FROM public.conversas);

DELETE FROM public.bot_logs
WHERE conversa_id IN (SELECT id FROM public.conversas);

DELETE FROM public.mensagens
WHERE conversa_id IN (SELECT id FROM public.conversas);

-- 3) Dependências dos clientes
DELETE FROM public.campanha_envios
WHERE cliente_id IN (SELECT id FROM public.clientes);

DELETE FROM public.cliente_tags
WHERE cliente_id IN (SELECT id FROM public.clientes);

DELETE FROM public.contato_opt_in
WHERE cliente_id IN (SELECT id FROM public.clientes);

DELETE FROM public.contato_opt_out
WHERE cliente_id IN (SELECT id FROM public.clientes);

-- 4) Tabelas principais
DELETE FROM public.conversas;
DELETE FROM public.clientes;

COMMIT;
