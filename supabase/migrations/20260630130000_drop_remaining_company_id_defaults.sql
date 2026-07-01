-- =====================================================
-- Hardening multi-tenant (parte 2): remove DEFAULT 1 remanescente
--
-- A migration 20260630120000 já tinha tornado company_id NOT NULL
-- nessas tabelas, mas não removeu o DEFAULT 1 que ainda existia nelas
-- no banco real (não estava documentado em backend/supabase/schema.sql,
-- que está desatualizado nesse ponto). Com NOT NULL + DEFAULT 1 juntos,
-- um insert que esqueça company_id NÃO falha — cai silenciosamente na
-- empresa 1, que era exatamente o risco que queríamos eliminar.
--
-- Verificação feita antes desta migration: todo INSERT de produção
-- (controllers/services/routes) nestas 8 tabelas já passa company_id
-- explicitamente (varredura estática completa, sem achados de risco).
-- Scripts de uso manual (scripts/test-chatbot.js, criar-admin.js,
-- validate-chatbot-setup.js) também já passam company_id.
--
-- Tabela extra encontrada nesta varredura que não estava na migration
-- anterior: cliente_tags (também tinha DEFAULT 1).
--
-- Execute este script no Supabase SQL Editor.
-- =====================================================

BEGIN;

ALTER TABLE public.atendimentos    ALTER COLUMN company_id DROP DEFAULT;
ALTER TABLE public.cliente_tags    ALTER COLUMN company_id DROP DEFAULT;
ALTER TABLE public.conversa_tags   ALTER COLUMN company_id DROP DEFAULT;
ALTER TABLE public.conversas       ALTER COLUMN company_id DROP DEFAULT;
ALTER TABLE public.departamentos   ALTER COLUMN company_id DROP DEFAULT;
ALTER TABLE public.mensagens       ALTER COLUMN company_id DROP DEFAULT;
ALTER TABLE public.tags            ALTER COLUMN company_id DROP DEFAULT;
ALTER TABLE public.usuarios        ALTER COLUMN company_id DROP DEFAULT;

COMMIT;
