-- Empresa 4: apaga SOMENTE clientes, conversas e mensagens (+ FKs).
-- Nao apaga usuarios, departamentos, tags, instancia nem campanhas.
-- Abra este arquivo, selecione tudo (Ctrl+A) e cole no SQL Editor do Supabase.

BEGIN;

SET LOCAL statement_timeout = '15min';

DELETE FROM public.avaliacoes_atendimento
WHERE company_id = 4
   OR conversa_id IN (SELECT id FROM public.conversas WHERE company_id = 4)
   OR cliente_id  IN (SELECT id FROM public.clientes  WHERE company_id = 4)
   OR atendimento_id IN (SELECT id FROM public.atendimentos WHERE company_id = 4);

DELETE FROM public.mensagens_ocultas
WHERE company_id = 4
   OR conversa_id IN (SELECT id FROM public.conversas WHERE company_id = 4);

DELETE FROM public.conversa_unreads
WHERE company_id = 4
   OR conversa_id IN (SELECT id FROM public.conversas WHERE company_id = 4);

DELETE FROM public.conversa_tags
WHERE company_id = 4
   OR conversa_id IN (SELECT id FROM public.conversas WHERE company_id = 4);

DELETE FROM public.atendimentos
WHERE company_id = 4
   OR conversa_id IN (SELECT id FROM public.conversas WHERE company_id = 4);

DELETE FROM public.historico_atendimentos
WHERE conversa_id IN (SELECT id FROM public.conversas WHERE company_id = 4);

DELETE FROM public.bot_logs
WHERE company_id = 4
   OR conversa_id IN (SELECT id FROM public.conversas WHERE company_id = 4);

DELETE FROM public.conversa_usuario_prefs
WHERE company_id = 4
   OR conversa_id IN (SELECT id FROM public.conversas WHERE company_id = 4);

DELETE FROM public.conversa_atendentes
WHERE company_id = 4
   OR conversa_id IN (SELECT id FROM public.conversas WHERE company_id = 4);

DELETE FROM public.departamento_grupos
WHERE company_id = 4
   OR conversa_id IN (SELECT id FROM public.conversas WHERE company_id = 4);

DELETE FROM public.mensagens
WHERE company_id = 4
   OR conversa_id IN (SELECT id FROM public.conversas WHERE company_id = 4);

DELETE FROM public.conversas
WHERE company_id = 4;

DELETE FROM public.cliente_tags
WHERE cliente_id IN (SELECT id FROM public.clientes WHERE company_id = 4);

DELETE FROM public.contato_opt_in
WHERE company_id = 4
   OR cliente_id IN (SELECT id FROM public.clientes WHERE company_id = 4);

DELETE FROM public.contato_opt_out
WHERE company_id = 4
   OR cliente_id IN (SELECT id FROM public.clientes WHERE company_id = 4);

DELETE FROM public.clientes
WHERE company_id = 4;

COMMIT;

SELECT
  (SELECT COUNT(*) FROM public.clientes  WHERE company_id = 4) AS clientes,
  (SELECT COUNT(*) FROM public.conversas WHERE company_id = 4) AS conversas,
  (SELECT COUNT(*) FROM public.mensagens WHERE company_id = 4) AS mensagens;
