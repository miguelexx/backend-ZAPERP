-- Execute no Supabase SQL Editor se avaliacoes_atendimento já existe sem atendente_id
-- Corrige: column "atendente_id" does not exist

-- 1) Adicionar coluna atendente_id (e FK se coluna nova)
ALTER TABLE public.avaliacoes_atendimento 
  ADD COLUMN IF NOT EXISTS atendente_id integer;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='avaliacoes_atendimento' AND column_name='atendente_id') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'avaliacoes_atendimento_atendente_fk') THEN
      ALTER TABLE public.avaliacoes_atendimento 
        ADD CONSTRAINT avaliacoes_atendimento_atendente_fk 
        FOREIGN KEY (atendente_id) REFERENCES public.usuarios(id);
    END IF;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FK: %', SQLERRM;
END $$;

-- 2) Preencher com de_usuario_id do atendimento (encerrou)
UPDATE public.avaliacoes_atendimento a 
SET atendente_id = at.de_usuario_id 
FROM public.atendimentos at 
WHERE at.id = a.atendimento_id AND a.atendente_id IS NULL;

-- 3) Para linhas sem atendente, usar primeiro usuário da empresa
UPDATE public.avaliacoes_atendimento a 
SET atendente_id = (SELECT id FROM public.usuarios WHERE company_id = a.company_id ORDER BY id LIMIT 1)
WHERE a.atendente_id IS NULL;

-- 4) NOT NULL somente se não houver nulos
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.avaliacoes_atendimento WHERE atendente_id IS NULL) THEN
    ALTER TABLE public.avaliacoes_atendimento ALTER COLUMN atendente_id SET NOT NULL;
  ELSE
    RAISE NOTICE 'Há linhas com atendente_id NULL. Corrija manualmente antes de SET NOT NULL.';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'SET NOT NULL: %', SQLERRM;
END $$;

-- 5) Índice
CREATE INDEX IF NOT EXISTS idx_avaliacoes_atendente 
  ON public.avaliacoes_atendimento (company_id, atendente_id);

-- 6) Comentário
COMMENT ON COLUMN public.avaliacoes_atendimento.atendente_id IS 'Usuário que atendeu o cliente (quem encerrou a conversa).';
