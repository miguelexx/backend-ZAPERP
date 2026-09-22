-- Triagem Interativa Whapi (2º provider) — módulo ADITIVO e INDEPENDENTE.
-- NÃO toca ia_config / chatbot_triage (chatbot de texto/números atual) nem UltraMSG.
-- Só faz sentido para instâncias whatsapp_instances.provider = 'whapi'.
-- Ver docs/ai-handoff/25-WHAPI-SEGUNDA-INTEGRACAO.md + docs/ai-handoff/26-WHAPI-TRIAGEM-INTERATIVA.md
--
-- ORDEM OBRIGATÓRIA: aplicar ANTES do deploy do código que lê estas tabelas.
-- O código é resiliente à ausência das tabelas (trata como "desligado"), mas o
-- recurso só funciona depois desta migration.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Configuração da triagem interativa por instância Whapi (1 linha por instância).
CREATE TABLE IF NOT EXISTS public.whapi_triage_config (
  id bigserial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  whatsapp_instance_id bigint NOT NULL REFERENCES public.whatsapp_instances(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  -- Como o menu é renderizado no WhatsApp:
  --   poll   = enquete nativa (RECOMENDADO — estável; botões são instáveis no WhatsApp)
  --   list   = mensagem interativa de lista (/messages/interactive)
  --   button = botões de resposta rápida (máx 3; instável do lado do provedor)
  mode text NOT NULL DEFAULT 'poll',
  body_text text NOT NULL DEFAULT 'Para facilitar seu atendimento, selecione o setor desejado.',
  button_label text NOT NULL DEFAULT 'Selecionar setor',
  header_text text,
  footer_text text,
  -- Confirmação enviada após a escolha ({{departamento}} é substituído). Vazio = usa a do chatbot.
  confirm_message text,
  -- Se o envio interativo falhar, cai no menu de texto do chatbot atual (quando ligado).
  fallback_to_text boolean NOT NULL DEFAULT true,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT whapi_triage_config_mode_chk CHECK (mode IN ('poll', 'list', 'button')),
  CONSTRAINT uq_whapi_triage_config_company_instance UNIQUE (company_id, whatsapp_instance_id)
);

COMMENT ON TABLE public.whapi_triage_config IS 'Triagem Interativa Whapi por instância. Aditivo; não substitui o chatbot_triage (texto) em ia_config.';
COMMENT ON COLUMN public.whapi_triage_config.mode IS 'poll (recomendado) | list | button. Botões são instáveis no WhatsApp; enquete é a alternativa estável.';

-- Opções do menu → setor. O id UUID é o provider_option_id ESTÁVEL enviado como id do
-- botão/linha; a resposta interativa volta com ele, então trocar o label NÃO quebra o vínculo.
-- departamento_id/tag_id sem FK de propósito (tabelas legadas, tipo variável); o runtime
-- valida a existência do setor (transferToDepartment) — mesmo padrão do chatbot atual.
CREATE TABLE IF NOT EXISTS public.whapi_triage_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  config_id bigint NOT NULL REFERENCES public.whapi_triage_config(id) ON DELETE CASCADE,
  company_id integer NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  label text NOT NULL,
  departamento_id bigint,
  tag_id bigint,
  ordem integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.whapi_triage_options IS 'Opções da Triagem Interativa Whapi. id UUID = provider_option_id estável (id do botão/linha).';
COMMENT ON COLUMN public.whapi_triage_options.id IS 'provider_option_id estável enviado à Whapi; a resposta interativa retorna este id (independe do label).';

CREATE INDEX IF NOT EXISTS idx_whapi_triage_config_company
  ON public.whapi_triage_config (company_id, whatsapp_instance_id);

CREATE INDEX IF NOT EXISTS idx_whapi_triage_options_config
  ON public.whapi_triage_options (config_id, ordem);

CREATE INDEX IF NOT EXISTS idx_whapi_triage_options_company
  ON public.whapi_triage_options (company_id);

-- Gatilho de atualizado_em (reusa padrão simples desta base).
CREATE OR REPLACE FUNCTION public.set_updated_at_whapi_triage()
RETURNS trigger AS $$
BEGIN
  NEW.atualizado_em = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_updated_at_whapi_triage_config_trg') THEN
    CREATE TRIGGER set_updated_at_whapi_triage_config_trg
    BEFORE UPDATE ON public.whapi_triage_config
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_whapi_triage();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_updated_at_whapi_triage_options_trg') THEN
    CREATE TRIGGER set_updated_at_whapi_triage_options_trg
    BEFORE UPDATE ON public.whapi_triage_options
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_whapi_triage();
  END IF;
END $$;
