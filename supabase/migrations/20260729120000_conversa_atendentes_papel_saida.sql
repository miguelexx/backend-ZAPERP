-- ============================================================
-- Múltiplos atendentes na conversa — completa a relação já existente.
--
-- A tabela public.conversa_atendentes já existe (20260619100000) com
-- company_id, conversa_id, usuario_id, adicionado_por, ativo, criado_em,
-- atualizado_em + índice único parcial (só linhas ativas) e índices de busca.
-- Esta migration NÃO recria nada disso: apenas acrescenta o que faltava para
-- a relação ficar completa conforme especificado —
--   função (papel) · quem removeu · data de saída.
--
-- O atendente PRINCIPAL continua sendo `conversas.atendente_id` — fonte única
-- da verdade. `papel` existe para tornar a linha auto-descritiva e permitir
-- relatórios sem join, nunca para duplicar o responsável.
--
-- Puramente ADITIVA e reversível: nenhuma coluna existente é alterada,
-- nenhuma linha antiga é reescrita.
-- ============================================================

BEGIN;

ALTER TABLE public.conversa_atendentes
  ADD COLUMN IF NOT EXISTS papel text NOT NULL DEFAULT 'co_atendente',
  ADD COLUMN IF NOT EXISTS removido_em timestamp with time zone,
  ADD COLUMN IF NOT EXISTS removido_por integer;

-- FK de quem removeu: mesmo comportamento de `adicionado_por` (SET NULL para
-- não perder o histórico de participação quando o usuário é excluído).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversa_atendentes_removido_por_fkey'
  ) THEN
    ALTER TABLE public.conversa_atendentes
      ADD CONSTRAINT conversa_atendentes_removido_por_fkey
      FOREIGN KEY (removido_por) REFERENCES public.usuarios(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Papéis aceitos. NOT VALID: linhas antigas já receberam o DEFAULT acima, mas
-- evita varredura da tabela inteira em base grande (o CHECK vale para todo
-- INSERT/UPDATE a partir daqui de qualquer forma).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversa_atendentes_papel_chk'
  ) THEN
    ALTER TABLE public.conversa_atendentes
      ADD CONSTRAINT conversa_atendentes_papel_chk
      CHECK (papel IN ('co_atendente', 'principal')) NOT VALID;
  END IF;
END $$;

-- Coerência entre `ativo` e a data de saída: participante ativo não tem saída;
-- participante removido tem. NOT VALID porque linhas desativadas antes desta
-- migration não têm `removido_em` e não devem quebrar o deploy.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversa_atendentes_saida_chk'
  ) THEN
    ALTER TABLE public.conversa_atendentes
      ADD CONSTRAINT conversa_atendentes_saida_chk
      CHECK (ativo = false OR removido_em IS NULL) NOT VALID;
  END IF;
END $$;

-- Histórico de participação por conversa (quem entrou e saiu, em ordem).
-- Não conflita com os índices parciais existentes, que só cobrem ativo = true.
CREATE INDEX IF NOT EXISTS idx_conversa_atendentes_historico
  ON public.conversa_atendentes (company_id, conversa_id, criado_em DESC);

COMMENT ON COLUMN public.conversa_atendentes.papel IS
  'Funcao na conversa. O principal e sempre conversas.atendente_id; aqui e co_atendente.';
COMMENT ON COLUMN public.conversa_atendentes.removido_em IS
  'Data de saida do participante (soft-delete; a linha e mantida para auditoria).';
COMMENT ON COLUMN public.conversa_atendentes.removido_por IS
  'Usuario que removeu o participante.';

COMMIT;

-- ============================================================
-- ROLLBACK (seguro — participantes ativos continuam funcionando, pois o
-- backend só depende de company_id/conversa_id/usuario_id/ativo):
--
--   BEGIN;
--   DROP INDEX IF EXISTS public.idx_conversa_atendentes_historico;
--   ALTER TABLE public.conversa_atendentes DROP CONSTRAINT IF EXISTS conversa_atendentes_saida_chk;
--   ALTER TABLE public.conversa_atendentes DROP CONSTRAINT IF EXISTS conversa_atendentes_papel_chk;
--   ALTER TABLE public.conversa_atendentes DROP CONSTRAINT IF EXISTS conversa_atendentes_removido_por_fkey;
--   ALTER TABLE public.conversa_atendentes DROP COLUMN IF EXISTS removido_por;
--   ALTER TABLE public.conversa_atendentes DROP COLUMN IF EXISTS removido_em;
--   ALTER TABLE public.conversa_atendentes DROP COLUMN IF EXISTS papel;
--   COMMIT;
-- ============================================================
