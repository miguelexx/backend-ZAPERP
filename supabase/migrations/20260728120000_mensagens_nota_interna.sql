-- ============================================================
-- Nota interna ("mensagem invisível") na linha do tempo da conversa.
--
-- Decisão técnica: NÃO cria tabela nova. A tabela public.mensagens já tem
-- tudo que a nota precisa (company_id NOT NULL + FK, conversa_id + FK,
-- autor_usuario_id, texto, tipo, direcao, status, criado_em, RLS por empresa
-- via app.company_id) e já é a fonte única do histórico exibido na conversa.
-- Uma tabela separada obrigaria a fundir duas fontes em toda paginação,
-- busca, impressão e cache — muito mais superfície de regressão do que a
-- extensão controlada abaixo.
--
-- A nota é identificada por TRÊS campos amarrados entre si:
--   tipo    = 'internal_note'
--   direcao = 'interna'   → fica fora de toda query existente que filtra
--                           direcao in ('in','out') ou direcao = 'out'
--                           (outbox/reconciliação, reenvio de mídia, SLA,
--                            limites de atendimento, métricas, proteções).
--   status  = 'interna'   → nunca pending/sending/sent/erro, logo nunca é
--                           recolhida por retry nem por reconciliação.
--
-- Migration puramente ADITIVA: não altera coluna existente, não reescreve
-- linha antiga, não cria default novo. Reversível (ver ROLLBACK no final).
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1) Invariantes de integridade da nota interna.
--
--    NOT VALID de propósito: um CHECK NOT VALID JÁ É APLICADO a todo
--    INSERT/UPDATE a partir daqui (só as linhas pré-existentes ficam de fora
--    da verificação retroativa). Como nenhuma linha antiga pode ter
--    tipo='internal_note' nem direcao='interna' (valores novos), o resultado
--    é idêntico ao de um CHECK validado — sem o seq scan da tabela inteira,
--    que em base grande travaria a migration.
--
--    Para validar retroativamente em janela de manutenção:
--      ALTER TABLE public.mensagens VALIDATE CONSTRAINT mensagens_nota_interna_chk;
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mensagens_nota_interna_chk'
  ) THEN
    ALTER TABLE public.mensagens
      ADD CONSTRAINT mensagens_nota_interna_chk CHECK (
        -- tipo e direcao só existem juntos: nenhum dos dois pode ser usado sozinho
        ((tipo = 'internal_note') = (direcao = 'interna'))
        AND (
          direcao <> 'interna'
          OR (
            -- nota interna nunca tem rastro de WhatsApp
            whatsapp_id IS NULL
            -- nunca carrega status de envio/entrega/leitura
            AND status = 'interna'
            AND COALESCE(status_mensagem, 'interna') = 'interna'
            -- sempre tem autor identificado (auditoria)
            AND autor_usuario_id IS NOT NULL
            -- conteúdo obrigatório
            AND length(btrim(texto)) > 0
          )
        )
      ) NOT VALID;
  END IF;
END $$;

-- provider_queue_id e whatsapp_instance_id só existem em bases já migradas
-- (20260703100000 / 20260615000000). Amarrados em constraint separada para
-- que esta migration continue aplicável em base parcialmente atualizada.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'mensagens'
       AND column_name = 'provider_queue_id'
  )
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'mensagens'
       AND column_name = 'whatsapp_instance_id'
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mensagens_nota_interna_sem_provedor_chk'
  ) THEN
    ALTER TABLE public.mensagens
      ADD CONSTRAINT mensagens_nota_interna_sem_provedor_chk CHECK (
        direcao <> 'interna'
        OR (provider_queue_id IS NULL AND whatsapp_instance_id IS NULL)
      ) NOT VALID;
  END IF;
END $$;

-- ------------------------------------------------------------
-- 2) Índice parcial para carregamento do histórico.
--    A leitura do histórico usa (company_id, conversa_id) ordenado por
--    (criado_em DESC, id DESC) — mesma forma dos índices já existentes.
--    Parcial em direcao='interna': custo de manutenção proporcional só ao
--    volume de notas, sem tocar nos índices das mensagens reais.
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_mensagens_nota_interna_conversa
  ON public.mensagens (company_id, conversa_id, criado_em DESC, id DESC)
  WHERE direcao = 'interna';

COMMENT ON INDEX public.idx_mensagens_nota_interna_conversa IS
  'Notas internas por conversa (histórico). Parcial: nao impacta mensagens in/out.';

COMMENT ON CONSTRAINT mensagens_nota_interna_chk ON public.mensagens IS
  'Nota interna: tipo/direcao/status amarrados, sem whatsapp_id, com autor e conteudo.';

COMMIT;

-- ============================================================
-- ROLLBACK (seguro; as notas já gravadas continuam legíveis como linhas
-- comuns de mensagens, apenas sem as invariantes):
--
--   BEGIN;
--   DROP INDEX IF EXISTS public.idx_mensagens_nota_interna_conversa;
--   ALTER TABLE public.mensagens DROP CONSTRAINT IF EXISTS mensagens_nota_interna_sem_provedor_chk;
--   ALTER TABLE public.mensagens DROP CONSTRAINT IF EXISTS mensagens_nota_interna_chk;
--   COMMIT;
--
-- Para remover também os dados (destrutivo, opcional):
--   DELETE FROM public.mensagens WHERE direcao = 'interna' AND tipo = 'internal_note';
-- ============================================================
