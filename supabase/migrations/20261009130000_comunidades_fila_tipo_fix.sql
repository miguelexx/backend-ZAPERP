-- FIX: garante a coluna `tipo` nas tabelas da fila de comunidades/grupos.
-- Contexto: o código novo (adição em massa p/ grupos E comunidades) insere a coluna `tipo`,
-- mas bancos que aplicaram a migration 20261009120000 ANTES dessa coluna existir não a têm,
-- causando 400 "Não foi possível criar a operação." ao enfileirar participantes.
-- Idempotente: pode rodar com segurança quantas vezes quiser.
--
-- Se der erro "relation ... does not exist", rode ANTES a migration completa
-- 20261009120000_comunidades_fila.sql e depois este arquivo.

ALTER TABLE public.comunidade_operacoes
  ADD COLUMN IF NOT EXISTS tipo text NOT NULL DEFAULT 'comunidade';

ALTER TABLE public.comunidade_fila_itens
  ADD COLUMN IF NOT EXISTS tipo text NOT NULL DEFAULT 'comunidade';
