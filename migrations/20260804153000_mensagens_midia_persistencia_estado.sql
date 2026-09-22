-- Estado da cópia de mídia inbound (UltraMSG -> /uploads).
-- Antes, o único sinal de progresso era a própria url (https = pendente, /uploads = copiada):
-- não dava para saber quantas vezes tentamos, por que falhou, nem quando tentar de novo, e duas
-- instâncias podiam baixar o mesmo arquivo ao mesmo tempo.
--
-- midia_persist_status:
--   NULL            - nunca tentado (mídia antiga, anterior a esta migration)
--   'pendente'      - falhou por motivo temporário; nova tentativa agendada em midia_persist_proxima_em
--   'concluida'     - arquivo já está em /uploads
--   'falha_definitiva' - não adianta tentar de novo (link removido, arquivo grande demais, formato
--                        desconhecido) ou o limite de tentativas acabou; a url remota é preservada
--
-- O backend degrada sem estas colunas: se a migration não estiver aplicada, a cópia e o retry
-- continuam funcionando em memória, apenas sem estado persistido entre reinícios.

ALTER TABLE public.mensagens
  ADD COLUMN IF NOT EXISTS midia_persist_status TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS midia_persist_tentativas INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS midia_persist_erro TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS midia_persist_erro_tipo TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS midia_persist_ultima_em TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS midia_persist_proxima_em TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS midia_persist_lock_ate TIMESTAMPTZ DEFAULT NULL;

-- Fila do scheduler: só as linhas que ainda esperam nova tentativa.
CREATE INDEX IF NOT EXISTS idx_mensagens_midia_persist_pendente
  ON public.mensagens (midia_persist_proxima_em, id)
  WHERE midia_persist_status = 'pendente';

COMMENT ON COLUMN public.mensagens.midia_persist_status
  IS 'Estado da cópia da mídia inbound para /uploads: pendente, concluida, falha_definitiva ou NULL (nunca tentado).';
COMMENT ON COLUMN public.mensagens.midia_persist_tentativas
  IS 'Quantidade de tentativas de cópia já feitas, incluindo a imediata pós-webhook.';
COMMENT ON COLUMN public.mensagens.midia_persist_erro
  IS 'Motivo resumido da última falha (sem URL assinada nem token).';
COMMENT ON COLUMN public.mensagens.midia_persist_erro_tipo
  IS 'Classificação da última falha: temporaria (vale retentar) ou definitiva.';
COMMENT ON COLUMN public.mensagens.midia_persist_ultima_em
  IS 'Quando a última tentativa de cópia foi executada.';
COMMENT ON COLUMN public.mensagens.midia_persist_proxima_em
  IS 'Quando a próxima tentativa deve ocorrer (backoff 1min, 5min, 15min, 30min, 1h).';
COMMENT ON COLUMN public.mensagens.midia_persist_lock_ate
  IS 'Lock de execução: enquanto estiver no futuro, outra instância não deve copiar esta mídia.';
