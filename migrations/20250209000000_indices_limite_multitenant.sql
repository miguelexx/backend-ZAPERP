-- =====================================================
-- ÍNDICES PARA PERFORMANCE (company_id, departamento_id, conversa_id)
-- =====================================================

CREATE INDEX IF NOT EXISTS idx_conversas_company_id ON public.conversas(company_id);
CREATE INDEX IF NOT EXISTS idx_conversas_departamento_id ON public.conversas(departamento_id);
CREATE INDEX IF NOT EXISTS idx_conversas_atendente_status ON public.conversas(company_id, atendente_id, status_atendimento);
CREATE INDEX IF NOT EXISTS idx_conversas_cliente_status ON public.conversas(company_id, cliente_id, status_atendimento);

CREATE INDEX IF NOT EXISTS idx_mensagens_company_conversa ON public.mensagens(company_id, conversa_id);
CREATE INDEX IF NOT EXISTS idx_mensagens_conversa_criado ON public.mensagens(conversa_id, criado_em);

CREATE INDEX IF NOT EXISTS idx_conversa_tags_conversa ON public.conversa_tags(conversa_id);
CREATE INDEX IF NOT EXISTS idx_conversa_tags_company ON public.conversa_tags(company_id);

CREATE INDEX IF NOT EXISTS idx_conversa_unreads_company_usuario ON public.conversa_unreads(company_id, usuario_id);

CREATE INDEX IF NOT EXISTS idx_clientes_company_telefone ON public.clientes(company_id, telefone);

CREATE INDEX IF NOT EXISTS idx_departamentos_company ON public.departamentos(company_id);

CREATE INDEX IF NOT EXISTS idx_atendimentos_company ON public.atendimentos(company_id);
CREATE INDEX IF NOT EXISTS idx_atendimentos_conversa ON public.atendimentos(conversa_id);

-- =====================================================
-- LIMITE DE CHATS SIMULTÂNEOS POR ATENDENTE (por empresa)
-- =====================================================

ALTER TABLE public.empresas ADD COLUMN IF NOT EXISTS limite_chats_por_atendente integer DEFAULT 10;
COMMENT ON COLUMN public.empresas.limite_chats_por_atendente IS 'Máximo de conversas em_atendimento que cada atendente pode ter simultaneamente. 0 = sem limite';

-- =====================================================
-- WEBHOOK MULTI-TENANT: mapear phone_number_id → company_id
-- O Meta envia metadata.phone_number_id no webhook
-- =====================================================

CREATE TABLE IF NOT EXISTS public.empresas_whatsapp (
  id serial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES public.empresas(id),
  phone_number_id varchar(100) NOT NULL,
  phone_number varchar(30),
  UNIQUE(phone_number_id)
);

CREATE INDEX IF NOT EXISTS idx_empresas_whatsapp_phone_id ON public.empresas_whatsapp(phone_number_id);
COMMENT ON TABLE public.empresas_whatsapp IS 'Mapeamento Meta WhatsApp phone_number_id → company_id para webhook multi-tenant';

-- =====================================================
-- TIMEOUT AUTOMÁTICO: última interação para inatividade
-- (usado por job/cron para fechar conversas inativas)
-- =====================================================

ALTER TABLE public.empresas ADD COLUMN IF NOT EXISTS timeout_inatividade_min integer DEFAULT 0;
COMMENT ON COLUMN public.empresas.timeout_inatividade_min IS 'Minutos sem resposta para fechar/reabrir automaticamente. 0 = desativado';
