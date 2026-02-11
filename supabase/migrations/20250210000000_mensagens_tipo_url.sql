-- Adiciona colunas para mídia (imagem, áudio, arquivo) em mensagens
ALTER TABLE public.mensagens
ADD COLUMN IF NOT EXISTS tipo varchar(20) DEFAULT 'texto',
ADD COLUMN IF NOT EXISTS url text,
ADD COLUMN IF NOT EXISTS nome_arquivo text;
