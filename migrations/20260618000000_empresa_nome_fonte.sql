-- Migration: adiciona coluna nome_fonte à tabela empresas
-- Armazena a chave da fonte escolhida para o nome da empresa no cabeçalho.
-- Valor padrão: 'inter' (fonte original, sem quebra de layout).

ALTER TABLE empresas
  ADD COLUMN IF NOT EXISTS nome_fonte TEXT NOT NULL DEFAULT 'inter';
