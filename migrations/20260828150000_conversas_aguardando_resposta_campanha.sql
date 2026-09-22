-- Filtro "Campanhas" na lista de conversas: origem persistente do módulo Disparo.
-- Não reclassifica conversas antigas (DEFAULT false, sem backfill).
-- Não reutiliza status_atendimento = mensagem_disparada (feature distinta:
-- envios pelo WhatsApp fora do CRM, opção empresas.separar_mensagens_disparadas).

BEGIN;

ALTER TABLE public.conversas
  ADD COLUMN IF NOT EXISTS aguardando_resposta_campanha boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.conversas.aguardando_resposta_campanha IS
  'True somente quando um disparo/campanha foi enviado e o contato ainda não respondeu. Exclui a conversa de Minha fila; o filtro Campanhas lista estas linhas. Isolamento por company_id na aplicação.';

CREATE INDEX IF NOT EXISTS idx_conversas_company_aguardando_campanha
  ON public.conversas (company_id, ultima_atividade DESC)
  WHERE aguardando_resposta_campanha = true
    AND (tipo IS NULL OR tipo <> 'grupo');

NOTIFY pgrst, 'reload schema';

COMMIT;
