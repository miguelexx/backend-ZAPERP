-- Manutenção: conversas em mensagem_disparada mas com pelo menos uma mensagem inbound no histórico
-- (estado inconsistente ou regra antiga). Reverte para aberta na fila.
-- Ajuste company_id se quiser limitar a um tenant.
--
-- Pré-visualização (recomendado):
-- SELECT c.id, c.company_id, c.status_atendimento, c.telefone
-- FROM public.conversas c
-- WHERE c.status_atendimento = 'mensagem_disparada'
--   AND EXISTS (
--     SELECT 1 FROM public.mensagens m
--     WHERE m.company_id = c.company_id AND m.conversa_id = c.id AND m.direcao = 'in'
--     LIMIT 1
--   );

UPDATE public.conversas c
SET
  status_atendimento = 'aberta',
  departamento_id = NULL,
  atendente_id = NULL,
  atendente_atribuido_em = NULL
WHERE c.status_atendimento = 'mensagem_disparada'
  AND EXISTS (
    SELECT 1
    FROM public.mensagens m
    WHERE m.company_id = c.company_id
      AND m.conversa_id = c.id
      AND m.direcao = 'in'
    LIMIT 1
  );
