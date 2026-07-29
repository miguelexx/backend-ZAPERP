-- Origem operacional explícita para métricas, SLA e auditoria.
-- A coluna não substitui autor_usuario_id: ela preserva o canal real do envio.

ALTER TABLE public.mensagens
  ADD COLUMN IF NOT EXISTS origem text;

UPDATE public.mensagens
SET origem = CASE
  WHEN direcao = 'in' THEN 'cliente'
  WHEN direcao = 'out' AND autor_usuario_id IS NOT NULL THEN 'sistema_humano'
  ELSE 'desconhecida'
END
WHERE origem IS NULL;

ALTER TABLE public.mensagens
  ALTER COLUMN origem SET DEFAULT 'desconhecida',
  ALTER COLUMN origem SET NOT NULL;

ALTER TABLE public.mensagens
  DROP CONSTRAINT IF EXISTS mensagens_origem_check;

ALTER TABLE public.mensagens
  ADD CONSTRAINT mensagens_origem_check
  CHECK (origem IN (
    'cliente',
    'sistema_humano',
    'whatsapp_celular',
    'automacao',
    'bot',
    'campanha',
    'sistema',
    'desconhecida'
  ));

CREATE INDEX IF NOT EXISTS idx_mensagens_dashboard_scope
  ON public.mensagens (company_id, whatsapp_instance_id, criado_em, direcao)
  WHERE apagada_para_todos = false;

COMMENT ON COLUMN public.mensagens.origem IS
  'Origem real: cliente, sistema_humano, whatsapp_celular, automacao/bot/campanha/sistema ou desconhecida para legado não comprovável.';

CREATE OR REPLACE FUNCTION public.set_mensagem_origem_operacional()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.direcao = 'in' AND (NEW.origem IS NULL OR NEW.origem = 'desconhecida') THEN
    NEW.origem := 'cliente';
  ELSIF NEW.direcao = 'out'
    AND NEW.autor_usuario_id IS NOT NULL
    AND (NEW.origem IS NULL OR NEW.origem = 'desconhecida') THEN
    NEW.origem := 'sistema_humano';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS mensagens_origem_operacional_trg ON public.mensagens;
CREATE TRIGGER mensagens_origem_operacional_trg
BEFORE INSERT OR UPDATE OF direcao, autor_usuario_id, origem
ON public.mensagens
FOR EACH ROW
EXECUTE FUNCTION public.set_mensagem_origem_operacional();
