-- Purge da empresa 19 (Maranata).
-- Cole ESTE arquivo inteiro no SQL Editor, apagando o snippet antigo.
-- Nao cole mensagem de erro. Rode uma vez so.
-- Se der erro, rode ROLLBACK; e pare. A transacao desfaz tudo.

BEGIN;

SET LOCAL statement_timeout = '30min';
SET LOCAL lock_timeout = '20s';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.empresas
    WHERE id = 19
      AND btrim(nome) = 'Maranata'
  ) THEN
    RAISE EXCEPTION 'Empresa 19 nao e a Maranata. Nada foi apagado.';
  END IF;

  PERFORM 1
  FROM public.empresas
  WHERE id = 19
  FOR UPDATE;
END
$$;

DELETE FROM public.historico_atendimentos
WHERE conversa_id IN (SELECT id FROM public.conversas WHERE company_id = 19)
   OR usuario_id IN (SELECT id FROM public.usuarios WHERE company_id = 19);

DELETE FROM public.internal_conversation_reads
WHERE conversation_id IN (SELECT id FROM public.internal_conversations WHERE company_id = 19)
   OR user_id IN (SELECT id FROM public.usuarios WHERE company_id = 19)
   OR last_read_message_id IN (SELECT id FROM public.internal_messages WHERE company_id = 19);

DELETE FROM public.push_inbound_delivery_log WHERE company_id = 19;
DELETE FROM public.bot_logs WHERE company_id = 19;
DELETE FROM public.atendimentos WHERE company_id = 19;
DELETE FROM public.conversa_unreads WHERE company_id = 19;
DELETE FROM public.conversa_usuario_prefs WHERE company_id = 19;
DELETE FROM public.mensagens WHERE company_id = 19;
DELETE FROM public.internal_messages WHERE company_id = 19;
DELETE FROM public.internal_conversation_participants WHERE company_id = 19;
DELETE FROM public.internal_conversations WHERE company_id = 19;
DELETE FROM public.conversas WHERE company_id = 19;
DELETE FROM public.usuario_departamentos WHERE company_id = 19;
DELETE FROM public.clientes WHERE company_id = 19;
DELETE FROM public.push_subscriptions WHERE company_id = 19;
DELETE FROM public.usuarios WHERE company_id = 19;
DELETE FROM public.ia_config WHERE company_id = 19;
DELETE FROM public.departamentos WHERE company_id = 19;
DELETE FROM public.webhook_logs WHERE company_id = 19;
DELETE FROM public.whatsapp_instances WHERE company_id = 19;

DELETE FROM public.empresas
WHERE id = 19
  AND btrim(nome) = 'Maranata';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.empresas WHERE id = 19) THEN
    RAISE EXCEPTION 'Empresa 19 ainda existe. Nada foi apagado.';
  END IF;
END
$$;

COMMIT;

SELECT id, nome, ativo
FROM public.empresas
WHERE id = 19;
