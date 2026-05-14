-- Ativa "separar mensagens disparadas" APENAS para a empresa id = 11.
-- Desliga para todas as outras empresas.
-- Idempotente: pode executar várias vezes.
--
-- Pré-visualização (opcional):
-- SELECT id, nome, separar_mensagens_disparadas FROM public.empresas ORDER BY id;

UPDATE public.empresas
SET separar_mensagens_disparadas = (id = 11);

-- Verificação rápida após rodar:
-- SELECT id, nome, separar_mensagens_disparadas FROM public.empresas WHERE separar_mensagens_disparadas IS DISTINCT FROM (id = 11);
