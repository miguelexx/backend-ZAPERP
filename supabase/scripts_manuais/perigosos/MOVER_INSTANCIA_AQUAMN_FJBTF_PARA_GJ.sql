-- =============================================================================
-- MOVER_INSTANCIA_AQUAMN_FJBTF_PARA_GJ.sql      *** ALTERA DADOS ***
-- =============================================================================
-- Move a instancia Whapi AQUAMN-FJBTF (numero 553434218097) da empresa 19
-- (Maranata) para a empresa 32 (GJ). O numero foi reaproveitado: o canal e o
-- mesmo, muda so o dono.
--
-- POR QUE: o inbound resolve a empresa SO pela instancia
-- (controllers/webhookInbound/instanceResolve.js). Enquanto a linha estiver com
-- company_id = 19, toda mensagem desse numero cai na Maranata -- nunca na GJ.
--
-- NAO e migration. Nao roda automaticamente. Rodar no SQL Editor do Supabase.
--
-- -----------------------------------------------------------------------------
-- ORDEM OBRIGATORIA
-- -----------------------------------------------------------------------------
--   1. Rodar ANTES o COMPANY_19_2_APAGAR.sql (zera o historico da Maranata).
--      Se rodar este script primeiro, as 4 conversas da empresa 19 que apontam
--      para a instancia ficam cross-tenant (conversa da 19 presa a instancia da
--      32) ate a limpeza passar.
--   2. Rodar este arquivo inteiro.
--   3. Criar um usuario admin na empresa 32 -- ela esta com ZERO usuarios.
--   4. Logado como esse admin, chamar
--      POST /integrations/whatsapp/instances/19/configure-webhooks
--      para o canal voltar a mandar o header X-Webhook-Token. Sem isso o webhook
--      continua levando 401 (rejected_token) e nada entra, mesmo com o
--      company_id certo.
--   5. Mandar uma mensagem para 553434218097 e conferir:
--      SELECT id, status, company_id, instance_id FROM public.webhook_logs
--      ORDER BY id DESC LIMIT 5;   -- tem que vir status=processed, company_id=32
--
-- ATENCAO: depois disto a empresa 19 fica SEM numero de WhatsApp. Se a Maranata
-- nao vai mais operar, considere descontinua-la de vez.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '30s';
SET LOCAL row_security = off;

DO $$
DECLARE
  v_instancia_id bigint := 19;          -- PK da linha em whatsapp_instances
  v_de           integer := 19;         -- empresa atual (Maranata)
  v_para         integer := 32;         -- empresa destino (GJ)
  v_canal        text    := 'AQUAMN-FJBTF';
  v_company_atual integer;
  v_canal_atual   text;
  v_conversas     bigint;
BEGIN
  SELECT company_id, instance_id
    INTO v_company_atual, v_canal_atual
  FROM public.whatsapp_instances
  WHERE id = v_instancia_id
  FOR UPDATE;

  IF v_company_atual IS NULL THEN
    RAISE EXCEPTION 'Instancia % nao existe. Nada foi alterado.', v_instancia_id;
  END IF;

  IF v_canal_atual IS DISTINCT FROM v_canal THEN
    RAISE EXCEPTION 'Instancia % e o canal %, nao %. Nada foi alterado.',
      v_instancia_id, v_canal_atual, v_canal;
  END IF;

  IF v_company_atual = v_para THEN
    RAISE NOTICE 'Instancia % ja esta na empresa %. Nada a fazer.', v_instancia_id, v_para;
    RETURN;
  END IF;

  IF v_company_atual IS DISTINCT FROM v_de THEN
    RAISE EXCEPTION 'Instancia % esta na empresa %, esperado %. Nada foi alterado.',
      v_instancia_id, v_company_atual, v_de;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.empresas WHERE id = v_para AND btrim(nome) ILIKE 'GJ') THEN
    RAISE EXCEPTION 'Empresa % nao se chama GJ. Nada foi alterado.', v_para;
  END IF;

  -- Conversas da empresa de origem ainda presas a esta instancia: depois da
  -- troca elas ficariam apontando para instancia de outra empresa.
  SELECT count(*) INTO v_conversas
  FROM public.conversas
  WHERE whatsapp_instance_id = v_instancia_id
    AND company_id = v_de;

  IF v_conversas > 0 THEN
    RAISE EXCEPTION
      'Ainda ha % conversa(s) da empresa % nesta instancia. Rode o COMPANY_19_2_APAGAR.sql antes. Nada foi alterado.',
      v_conversas, v_de;
  END IF;

  -- Acesso de atendente a instancia: o vinculo e da empresa antiga, nao segue junto.
  DELETE FROM public.usuario_whatsapp_instance_access
  WHERE whatsapp_instance_id = v_instancia_id;

  UPDATE public.whatsapp_instances
  SET company_id   = v_para,
      is_default   = true,
      ativo        = true,
      atualizado_em = now()
  WHERE id = v_instancia_id;

  -- Garante uma unica default na empresa destino.
  UPDATE public.whatsapp_instances
  SET is_default = false
  WHERE company_id = v_para
    AND id <> v_instancia_id
    AND is_default;

  RAISE NOTICE 'Instancia % (%) movida da empresa % para a %.',
    v_instancia_id, v_canal, v_de, v_para;
END
$$;

SELECT id, company_id, provider, nome, instance_id, telefone_conectado, ativo, is_default, status
FROM public.whatsapp_instances
WHERE id = 19;

COMMIT;
