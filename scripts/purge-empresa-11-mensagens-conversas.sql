-- Apaga so mensagens e conversas da empresa 11.
-- Usuarios, clientes, departamentos, instancia e a empresa continuam.
-- Cole este arquivo inteiro no SQL Editor e rode uma vez.
-- Se der erro, rode ROLLBACK; e pare.

BEGIN;

SET LOCAL statement_timeout = '30min';
SET LOCAL lock_timeout = '20s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.empresas WHERE id = 11) THEN
    RAISE EXCEPTION 'Empresa 11 nao existe. Nada foi apagado.';
  END IF;

  PERFORM 1 FROM public.empresas WHERE id = 11 FOR UPDATE;
END
$$;

-- Filhos que travam o DELETE da conversa. Tabela ausente e ignorada.
DO $$
BEGIN
  BEGIN
    DELETE FROM public.mensagens_ocultas
    WHERE company_id = 11
      AND conversa_id IN (SELECT id FROM public.conversas WHERE company_id = 11);
  EXCEPTION WHEN undefined_table THEN NULL;
  END;

  BEGIN
    DELETE FROM public.alerta_atendimento_sem_resposta_eventos
    WHERE company_id = 11;
  EXCEPTION WHEN undefined_table THEN NULL;
  END;

  BEGIN
    DELETE FROM public.alerta_atendimento_sem_resposta_estado
    WHERE company_id = 11;
  EXCEPTION WHEN undefined_table THEN NULL;
  END;

  BEGIN
    DELETE FROM public.avaliacoes_atendimento
    WHERE company_id = 11
       OR conversa_id IN (SELECT id FROM public.conversas WHERE company_id = 11);
  EXCEPTION WHEN undefined_table THEN NULL;
  END;

  BEGIN
    DELETE FROM public.conversa_atendentes
    WHERE company_id = 11
       OR conversa_id IN (SELECT id FROM public.conversas WHERE company_id = 11);
  EXCEPTION WHEN undefined_table THEN NULL;
  END;

  BEGIN
    DELETE FROM public.departamento_grupos
    WHERE company_id = 11
       OR conversa_id IN (SELECT id FROM public.conversas WHERE company_id = 11);
  EXCEPTION WHEN undefined_table THEN NULL;
  END;
END
$$;

DELETE FROM public.historico_atendimentos
WHERE conversa_id IN (SELECT id FROM public.conversas WHERE company_id = 11);

DELETE FROM public.bot_logs
WHERE conversa_id IN (SELECT id FROM public.conversas WHERE company_id = 11);

DELETE FROM public.atendimentos
WHERE company_id = 11
   OR conversa_id IN (SELECT id FROM public.conversas WHERE company_id = 11);

DELETE FROM public.conversa_tags
WHERE company_id = 11
   OR conversa_id IN (SELECT id FROM public.conversas WHERE company_id = 11);

DELETE FROM public.conversa_unreads
WHERE company_id = 11
   OR conversa_id IN (SELECT id FROM public.conversas WHERE company_id = 11);

DELETE FROM public.conversa_usuario_prefs
WHERE company_id = 11
   OR conversa_id IN (SELECT id FROM public.conversas WHERE company_id = 11);

DELETE FROM public.mensagens
WHERE company_id = 11
   OR conversa_id IN (SELECT id FROM public.conversas WHERE company_id = 11);

DELETE FROM public.conversas
WHERE company_id = 11;

COMMIT;

SELECT
  e.id,
  e.nome,
  (SELECT count(*) FROM public.mensagens m WHERE m.company_id = 11) AS mensagens,
  (SELECT count(*) FROM public.conversas c WHERE c.company_id = 11) AS conversas
FROM public.empresas e
WHERE e.id = 11;
