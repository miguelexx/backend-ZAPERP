-- Isola execuções live de workers configurados apenas para dry-run.
-- Um worker live passa NULL e pode consumir ambos os modos; um worker sem
-- capacidade live passa TRUE e só recebe execuções explicitamente dry-run.

CREATE OR REPLACE FUNCTION public.disparo_claim_fila_itens(
  p_worker_id text,
  p_limit integer DEFAULT 5,
  p_lease_seconds integer DEFAULT 120,
  p_instancia_id integer DEFAULT NULL,
  p_execucao_dry_run boolean DEFAULT NULL
)
RETURNS SETOF public.disparo_fila_itens
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit integer := GREATEST(1, LEAST(COALESCE(p_limit, 5), 50));
  v_lease interval := make_interval(secs => GREATEST(30, LEAST(COALESCE(p_lease_seconds, 120), 900)));
BEGIN
  IF p_worker_id IS NULL OR length(trim(p_worker_id)) = 0 THEN
    RAISE EXCEPTION 'worker_id obrigatorio';
  END IF;

  RETURN QUERY
  WITH candidatos AS (
    SELECT f.id
    FROM public.disparo_fila_itens f
    INNER JOIN public.disparo_execucoes e ON e.id = f.execucao_id
    WHERE f.status = 'pendente'
      AND f.proxima_tentativa_em <= now()
      AND e.status = 'em_execucao'
      AND (p_instancia_id IS NULL OR f.instancia_id = p_instancia_id)
      AND (p_execucao_dry_run IS NULL OR e.dry_run = p_execucao_dry_run)
    ORDER BY f.proxima_tentativa_em ASC, f.id ASC
    FOR UPDATE OF f SKIP LOCKED
    LIMIT v_limit
  )
  UPDATE public.disparo_fila_itens f
  SET
    status = 'reservada',
    worker_id = p_worker_id,
    lease_inicio = now(),
    lease_ate = now() + v_lease,
    atualizado_em = now()
  FROM candidatos c
  WHERE f.id = c.id
  RETURNING f.*;
END;
$$;

REVOKE ALL ON FUNCTION public.disparo_claim_fila_itens(text, integer, integer, integer, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.disparo_claim_fila_itens(text, integer, integer, integer, boolean) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.disparo_claim_fila_itens(text, integer, integer, integer, boolean) TO service_role;

COMMENT ON FUNCTION public.disparo_claim_fila_itens(text, integer, integer, integer, boolean) IS
  'Claim atomico da fila com isolamento opcional pelo modo dry_run da execucao.';
