-- Armazenamento de mídia em nuvem (Cloudflare R2) — rollout gradual por empresa.
--
-- Estratégia ADITIVA e reversível: nada aqui altera o comportamento das empresas que
-- continuam em disco. Enquanto a empresa não estiver habilitada para R2, estas colunas
-- ficam NULL e a leitura usa a coluna `url` como sempre.
--
-- Modelo de referência da mídia:
--   url             - o que o frontend consome. Para mídia migrada ao R2 vira "/media/r2/<key>";
--                     para as demais continua "/uploads/..." ou "https://..." (provedor).
--   storage_backend - 'r2' quando a mídia vive no R2; NULL/ausente = disco/remoto (fluxo antigo).
--   storage_key     - chave do objeto no bucket R2 (ex.: media/1/2026/08/imagem/arquivo.jpg).
--   url_legado      - backup do "/uploads/..." original. O arquivo local é mantido como rede de
--                     segurança e permite rollback instantâneo (basta restaurar url = url_legado).
--
-- O backend degrada sem estas colunas: se a migration não estiver aplicada, o espelhamento
-- para R2 simplesmente não ocorre e tudo segue em disco (nenhum erro para o usuário).

ALTER TABLE public.mensagens
  ADD COLUMN IF NOT EXISTS storage_backend TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS storage_key TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS url_legado TEXT DEFAULT NULL;

-- Fila do espelhamento/varredura: mídia da empresa ainda em /uploads e sem chave no R2.
-- Índice parcial pequeno — só cobre o que falta migrar.
CREATE INDEX IF NOT EXISTS idx_mensagens_storage_pendente_r2
  ON public.mensagens (company_id, id)
  WHERE storage_key IS NULL AND url LIKE '/uploads/%';

COMMENT ON COLUMN public.mensagens.storage_backend
  IS 'Backend de armazenamento da mídia: r2 (Cloudflare R2) ou NULL (disco /uploads ou URL remota — fluxo antigo).';
COMMENT ON COLUMN public.mensagens.storage_key
  IS 'Chave do objeto no bucket R2 quando storage_backend = r2 (ex.: media/1/2026/08/imagem/arquivo.jpg).';
COMMENT ON COLUMN public.mensagens.url_legado
  IS 'Backup do caminho /uploads original antes da migração para R2. Usado para rollback e para reenvio/encaminhamento via arquivo local.';
