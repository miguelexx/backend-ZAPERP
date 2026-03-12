-- =====================================================
-- REMOVER TODOS OS BLOQUEIOS DE ENVIO DE MENSAGENS
-- Execute no Supabase SQL Editor ou via psql
-- =====================================================
-- Este script desativa: proteção de volume/frequência,
-- processamento pausado, modo seguro e bloqueios do QR.
-- Use quando mensagens aparecem "enviadas" no log mas
-- não chegam ou há bloqueios indesejados.
-- =====================================================

-- 1) EMPRESAS — Zerar limites de proteção (0 = desativado)
-- intervalo_minimo: segundos entre mensagens ao mesmo contato
-- limite_por_minuto, limite_por_hora: volume máximo
UPDATE public.empresas
SET
  intervalo_minimo_entre_mensagens_seg = 0,
  limite_por_minuto = 0,
  limite_por_hora = 0
WHERE true;

-- 2) CONFIGURACOES_OPERACIONAIS — Desativar pausas e restrições
-- processamento_pausado: pausa jobs (sync, etc.)
-- modo_seguro: restrições adicionais
-- somente_atendimento_humano: desativa automações
UPDATE public.configuracoes_operacionais
SET
  processamento_pausado = false,
  modo_seguro = false,
  somente_atendimento_humano = false,
  atualizado_em = now()
WHERE true;

-- 3) ZAPI_CONNECT_GUARD — Remover bloqueio de QR Code
-- blocked_until: quando preenchido, bloqueia novas tentativas de conectar
UPDATE public.zapi_connect_guard
SET
  blocked_until = null,
  qr_attempts = 0
WHERE blocked_until IS NOT NULL OR qr_attempts > 0;

-- 4) Inserir configuracoes_operacionais para empresas que não têm
-- (evita processamento_pausado default true em novos registros)
INSERT INTO public.configuracoes_operacionais (company_id, sync_auto, modo_seguro, processamento_pausado, somente_atendimento_humano)
SELECT e.id, false, false, false, false
FROM public.empresas e
WHERE NOT EXISTS (
  SELECT 1 FROM public.configuracoes_operacionais c WHERE c.company_id = e.id
)
ON CONFLICT (company_id) DO NOTHING;

-- 5) Garantir colunas de proteção existem (se migrations não rodaram)
ALTER TABLE public.empresas ADD COLUMN IF NOT EXISTS intervalo_minimo_entre_mensagens_seg integer DEFAULT 0;
ALTER TABLE public.empresas ADD COLUMN IF NOT EXISTS limite_por_minuto integer DEFAULT 0;
ALTER TABLE public.empresas ADD COLUMN IF NOT EXISTS limite_por_hora integer DEFAULT 0;

-- Verificação (opcional): listar estado após execução
-- SELECT id, nome, intervalo_minimo_entre_mensagens_seg, limite_por_minuto, limite_por_hora FROM public.empresas;
-- SELECT company_id, processamento_pausado, modo_seguro FROM public.configuracoes_operacionais;
-- SELECT company_id, blocked_until, qr_attempts FROM public.zapi_connect_guard;
