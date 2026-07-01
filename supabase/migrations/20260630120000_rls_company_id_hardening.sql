-- =====================================================
-- Hardening multi-tenant: RLS + company_id NOT NULL
--
-- Por que: o backend usa SUPABASE_SERVICE_ROLE_KEY (sempre ignora RLS),
-- então isto NÃO muda o comportamento atual do sistema. É defesa em
-- profundidade contra: (a) uso futuro de chave anon (edge function, app
-- mobile), (b) bug que esqueça um .eq('company_id', ...) em alguma query,
-- (c) insert que esqueça de informar company_id e caia silenciosamente
-- em outra empresa (era o caso de public.clientes, que tinha DEFAULT 1).
--
-- Padrão de RLS replicado de 20250227000001_ai_tables.sql (ai_logs/ai_cache).
--
-- Execute este script no Supabase SQL Editor.
-- Se o bloco de verificação abaixo abortar com "Migration abortada", NÃO
-- force a aplicação: ele está listando exatamente quais tabelas têm linhas
-- com company_id NULL. Corrija essas linhas manualmente (atribua a empresa
-- correta com base em dados relacionados) e rode o script de novo.
-- =====================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0) Verificação de segurança — aborta a transação inteira se houver
--    linhas órfãs (company_id NULL) nas tabelas que vamos tornar NOT NULL.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_report text := '';
  v_count  int;
BEGIN
  SELECT count(*) INTO v_count FROM public.atendimentos WHERE company_id IS NULL;
  IF v_count > 0 THEN v_report := v_report || format(E'\n  - atendimentos: %s linha(s)', v_count); END IF;

  SELECT count(*) INTO v_count FROM public.conversas WHERE company_id IS NULL;
  IF v_count > 0 THEN v_report := v_report || format(E'\n  - conversas: %s linha(s)', v_count); END IF;

  SELECT count(*) INTO v_count FROM public.mensagens WHERE company_id IS NULL;
  IF v_count > 0 THEN v_report := v_report || format(E'\n  - mensagens: %s linha(s)', v_count); END IF;

  SELECT count(*) INTO v_count FROM public.tags WHERE company_id IS NULL;
  IF v_count > 0 THEN v_report := v_report || format(E'\n  - tags: %s linha(s)', v_count); END IF;

  SELECT count(*) INTO v_count FROM public.conversa_tags WHERE company_id IS NULL;
  IF v_count > 0 THEN v_report := v_report || format(E'\n  - conversa_tags: %s linha(s)', v_count); END IF;

  SELECT count(*) INTO v_count FROM public.departamentos WHERE company_id IS NULL;
  IF v_count > 0 THEN v_report := v_report || format(E'\n  - departamentos: %s linha(s)', v_count); END IF;

  SELECT count(*) INTO v_count FROM public.usuarios WHERE company_id IS NULL;
  IF v_count > 0 THEN v_report := v_report || format(E'\n  - usuarios: %s linha(s)', v_count); END IF;

  IF v_report <> '' THEN
    RAISE EXCEPTION E'Migration abortada: existem linhas com company_id NULL que precisam ser corrigidas manualmente antes de aplicar NOT NULL:%\n\nNenhuma alteração foi aplicada (transação revertida).', v_report;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1) company_id NOT NULL nas tabelas centrais multi-tenant
--    (clientes e conversa_unreads já são NOT NULL — nada a fazer nelas aqui)
-- ---------------------------------------------------------------------------
ALTER TABLE public.atendimentos    ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE public.conversas       ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE public.mensagens       ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE public.tags            ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE public.conversa_tags   ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE public.departamentos   ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE public.usuarios        ALTER COLUMN company_id SET NOT NULL;

-- ---------------------------------------------------------------------------
-- 2) Remove o DEFAULT 1 de clientes.company_id — um insert que esqueça de
--    passar company_id deve FALHAR (NOT NULL sem default), não cair
--    silenciosamente na empresa 1.
-- ---------------------------------------------------------------------------
ALTER TABLE public.clientes ALTER COLUMN company_id DROP DEFAULT;

-- ---------------------------------------------------------------------------
-- 3) RLS — isolamento por empresa via current_setting('app.company_id').
--    webhook_logs fica de fora do NOT NULL (company_id pode ser NULL de
--    propósito ali, para logar webhooks cuja empresa não foi resolvida),
--    mas ganha RLS igual às demais.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'clientes', 'conversas', 'mensagens', 'tags', 'conversa_tags',
    'atendimentos', 'departamentos', 'usuarios', 'conversa_unreads',
    'webhook_logs'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = t || '_company_isolation'
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I USING (company_id = (current_setting(''app.company_id'', true)::int))',
        t || '_company_isolation', t
      );
    END IF;
  END LOOP;
END $$;

COMMIT;
