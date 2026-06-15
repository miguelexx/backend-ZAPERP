-- Opcional para producao: criar indices potencialmente grandes fora de transaction.
-- Rode manualmente no PostgreSQL, uma instrucao por vez. CREATE INDEX CONCURRENTLY
-- nao pode rodar dentro de transaction block.
--
-- Use este roteiro se as tabelas abaixo forem grandes e voce optar por remover/separar
-- esses indices da migration regular em um deploy de producao.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversas_whatsapp_instance_id
  ON public.conversas (whatsapp_instance_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_mensagens_whatsapp_instance_id
  ON public.mensagens (whatsapp_instance_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_webhook_logs_whatsapp_instance_id
  ON public.webhook_logs (whatsapp_instance_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_whatsapp_envio_guard_logs_instance_id
  ON public.whatsapp_envio_guard_logs (whatsapp_instance_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_campanhas_whatsapp_instance_id
  ON public.campanhas (whatsapp_instance_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_campanha_envios_whatsapp_instance_id
  ON public.campanha_envios (whatsapp_instance_id);
