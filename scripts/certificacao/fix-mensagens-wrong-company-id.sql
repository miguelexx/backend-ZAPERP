-- =============================================================================
-- REPARAÇÃO OPCIONAL: mensagens da empresa 2 que foram salvas com company_id=1
-- =============================================================================
-- Use SOMENTE quando você tem PROVA de que mensagens específicas vieram da
-- instância da empresa 2 (instanceId em empresa_zapi).
--
-- CRITÉRIO SEGURO: liste os whatsapp_id que você confirmou como origem empresa 2.
-- NÃO execute com critério amplo (ex: intervalo de datas) — risco de mover dados
-- da empresa 1 por engano.
-- =============================================================================

-- 1) Listar mensagens suspeitas (company_id=1 mas vieram da instância empresa 2)
--    Ajuste os whatsapp_ids com base no log [ZAPI_WEBHOOK] ou análise manual.
/*
SELECT id, company_id, whatsapp_id, conversa_id, texto, direcao, criado_em
FROM public.mensagens
WHERE company_id = 1
  AND whatsapp_id IN (
    '3A1E59993ACD7C37A315',  -- exemplos: substitua pelos IDs que você confirmou
    'OUTRO_WHATSAPP_ID'
  );
*/

-- 2) Mover para company_id correto (EXECUTE APENAS APÓS CONFIRMAR A LISTA)
--    Substitua 2 pelo company_id real da empresa e liste os whatsapp_ids.
/*
UPDATE public.mensagens
SET company_id = 2
WHERE company_id = 1
  AND whatsapp_id IN (
    '3A1E59993ACD7C37A315'
    -- adicione outros IDs confirmados
  );
*/

-- 3) Verificar após a correção
/*
SELECT company_id, COUNT(*) as total
FROM public.mensagens
WHERE whatsapp_id IN ('3A1E59993ACD7C37A315')
GROUP BY company_id;
-- Esperado: 1 linha com company_id=2, total=1
*/
