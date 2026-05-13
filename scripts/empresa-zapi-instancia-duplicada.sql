-- Diagnóstico: mesma instância UltraMsg em mais do que uma empresa ativa
-- (causa típica: mensagens iam para o company_id mais baixo antes da correção no backend)
--
-- No backend, por defeito o mapeamento instance_id → company_id mantém o comportamento
-- histórico (menor company_id). Opcional no .env: WEBHOOK_INSTANCE_DUPLICATE_STRATEGY=recent
--
-- 1) Ver todas as linhas ativas para instance89002
SELECT company_id, instance_id, ativo, atualizado_em, criado_em
FROM public.empresa_zapi
WHERE ativo = true
  AND (
    instance_id IN ('instance89002', '89002')
    OR instance_id ILIKE '%89002%'
  )
ORDER BY atualizado_em DESC NULLS LAST;

-- 2) Instâncias repetidas (qualquer texto de instance_id)
SELECT instance_id, COUNT(*) AS linhas_ativas, array_agg(company_id ORDER BY atualizado_em DESC) AS companies
FROM public.empresa_zapi
WHERE ativo = true
GROUP BY instance_id
HAVING COUNT(*) > 1;

-- 3) REPARO (revise os company_id antes de correr): desativar duplicados errados, deixar só a empresa 6
-- UPDATE public.empresa_zapi SET ativo = false, atualizado_em = now()
-- WHERE ativo = true AND instance_id = 'instance89002' AND company_id <> 6;
