-- Fase 2 operacional multi-instancia WhatsApp/UltraMsg.
-- Migration aditiva e segura: nao remove constraints antigas nem apaga dados.

-- Consultas quentes do webhook/conversa por empresa + instancia + telefone/LID.
create index if not exists idx_conversas_company_whatsapp_instance_telefone
  on public.conversas (company_id, whatsapp_instance_id, telefone)
  where whatsapp_instance_id is not null;

create index if not exists idx_conversas_company_whatsapp_instance_chat_lid
  on public.conversas (company_id, whatsapp_instance_id, chat_lid)
  where whatsapp_instance_id is not null and chat_lid is not null;

-- Idempotencia/status por instancia quando o webhook trouxe provider instance id resolvido.
create index if not exists idx_mensagens_company_whatsapp_instance_whatsapp_id
  on public.mensagens (company_id, whatsapp_instance_id, whatsapp_id)
  where whatsapp_instance_id is not null and whatsapp_id is not null;

create index if not exists idx_mensagens_company_whatsapp_instance_conversa
  on public.mensagens (company_id, whatsapp_instance_id, conversa_id, criado_em desc)
  where whatsapp_instance_id is not null;

comment on index public.idx_conversas_company_whatsapp_instance_telefone is
  'Fase 2: busca conversa por telefone isolada por instancia WhatsApp.';

comment on index public.idx_conversas_company_whatsapp_instance_chat_lid is
  'Fase 2: busca conversa por chat_lid isolada por instancia WhatsApp.';

comment on index public.idx_mensagens_company_whatsapp_instance_whatsapp_id is
  'Fase 2: status/idempotencia por whatsapp_id isolados por instancia.';

comment on index public.idx_mensagens_company_whatsapp_instance_conversa is
  'Fase 2: historico/reconciliacao de mensagens por conversa e instancia.';
