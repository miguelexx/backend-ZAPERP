-- Etapa 9: correções de auditoria (lease recovery, índices, unique execução ativa).
-- NÃO aplicar sem autorização. Idempotente quando possível.

-- 1) Recovery de leases: enviando expirado → incerta (nunca reabrir como pendente)
CREATE OR REPLACE FUNCTION public.disparo_recuperar_leases_expirados(
  p_limit integer DEFAULT 100
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer := 0;
  v_reservadas integer := 0;
  v_enviando integer := 0;
BEGIN
  -- reservada expirada: seguro voltar a pendente (ainda não chamou o provedor)
  WITH upd AS (
    UPDATE public.disparo_fila_itens
    SET
      status = 'pendente',
      worker_id = NULL,
      lease_inicio = NULL,
      lease_ate = NULL,
      atualizado_em = now(),
      proxima_tentativa_em = now()
    WHERE id IN (
      SELECT id FROM public.disparo_fila_itens
      WHERE status = 'reservada'
        AND lease_ate IS NOT NULL
        AND lease_ate < now()
      ORDER BY lease_ate ASC
      FOR UPDATE SKIP LOCKED
      LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 100), 500))
    )
    RETURNING id
  )
  SELECT COUNT(*)::integer INTO v_reservadas FROM upd;

  -- enviando expirada: estado incerto (pode ter sido aceita pelo provedor)
  WITH upd2 AS (
    UPDATE public.disparo_fila_itens
    SET
      status = 'incerta',
      worker_id = NULL,
      lease_inicio = NULL,
      lease_ate = NULL,
      erro_codigo = COALESCE(erro_codigo, 'LEASE_EXPIRADO'),
      erro_mensagem = COALESCE(erro_mensagem, 'Lease expirado durante enviando — requer reconciliação'),
      erro_classificacao = 'temporario',
      atualizado_em = now()
    WHERE id IN (
      SELECT id FROM public.disparo_fila_itens
      WHERE status = 'enviando'
        AND lease_ate IS NOT NULL
        AND lease_ate < now()
      ORDER BY lease_ate ASC
      FOR UPDATE SKIP LOCKED
      LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 100), 500))
    )
    RETURNING id
  )
  SELECT COUNT(*)::integer INTO v_enviando FROM upd2;

  v_count := COALESCE(v_reservadas, 0) + COALESCE(v_enviando, 0);
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.disparo_recuperar_leases_expirados(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.disparo_recuperar_leases_expirados(integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.disparo_recuperar_leases_expirados(integer) TO service_role;

COMMENT ON FUNCTION public.disparo_recuperar_leases_expirados(integer) IS
  'Etapa 9: reservada→pendente; enviando→incerta (anti-duplicidade).';

-- 2) No máximo uma execução ativa por campanha+versão
CREATE UNIQUE INDEX IF NOT EXISTS uq_disparo_execucao_ativa_campanha_versao
  ON public.disparo_execucoes (campanha_id, versao)
  WHERE status IN ('aguardando', 'em_execucao', 'pausada');

-- 3) Índice para opt-out / lookup por telefone
CREATE INDEX IF NOT EXISTS idx_disparo_dest_company_telefone
  ON public.disparo_campanha_destinatarios (company_id, telefone_normalizado);

-- 4) Contadores opcionais de respondidas/optouts na execução (não destrutivo)
ALTER TABLE public.disparo_execucoes
  ADD COLUMN IF NOT EXISTS total_respondidas integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_optouts integer NOT NULL DEFAULT 0;
