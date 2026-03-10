-- Anti-bloqueio WhatsApp: defaults seguros para empresas que usam Z-API
-- Aplica 5s, 40/min, 400/hora apenas onde coluna está NULL ou 0.
-- Empresas podem alterar para 0 manualmente para desativar (com FEATURE_PROTECAO=1).

UPDATE public.empresas e
SET
  intervalo_minimo_entre_mensagens_seg = COALESCE(NULLIF(e.intervalo_minimo_entre_mensagens_seg, 0), 5),
  limite_por_minuto = COALESCE(NULLIF(e.limite_por_minuto, 0), 40),
  limite_por_hora = COALESCE(NULLIF(e.limite_por_hora, 0), 400)
WHERE e.id IN (SELECT ez.company_id FROM public.empresa_zapi ez WHERE ez.ativo = true)
AND (
  (e.intervalo_minimo_entre_mensagens_seg IS NULL OR e.intervalo_minimo_entre_mensagens_seg = 0)
  OR (e.limite_por_minuto IS NULL OR e.limite_por_minuto = 0)
  OR (e.limite_por_hora IS NULL OR e.limite_por_hora = 0)
);
