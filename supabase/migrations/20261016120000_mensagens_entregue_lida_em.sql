-- Horário de ENTREGA e de LEITURA da mensagem enviada (F9 do doc 33).
--
-- Até aqui só existia o status atual (`status`/`status_mensagem`): a tela não tinha como mostrar
-- "Entregue às 14:32 · Visualizada às 14:35", como o WhatsApp faz em "Dados da mensagem".
-- O frontend já consultava `msg.lida_em`/`entregue_em` em `bubbleStatus.js`, mas as colunas não
-- existiam — era código morto, sempre falso.
--
-- Preenchidas pelo caminho de ACK (`patchMensagemStatusById`), uma vez só: o primeiro ACK que
-- atinge delivered grava `entregue_em`; o primeiro que atinge read/played grava `lida_em` (e
-- `entregue_em` se ainda estiver vazio, porque leitura implica entrega). ACK reentregue não
-- reescreve o horário — quem chegou primeiro manda.
--
-- Nulo = sem informação (mensagem não confirmada, ou confirmada antes desta migration).
-- NÃO retroativo de propósito: inventar horário a partir de `atualizado_em` seria chute.

ALTER TABLE public.mensagens
  ADD COLUMN IF NOT EXISTS entregue_em timestamptz,
  ADD COLUMN IF NOT EXISTS lida_em timestamptz;

COMMENT ON COLUMN public.mensagens.entregue_em IS
  'Instante do primeiro ACK de entrega (delivered). Nulo = nunca confirmada ou anterior à migration.';

COMMENT ON COLUMN public.mensagens.lida_em IS
  'Instante do primeiro ACK de leitura (read/played). Nulo = nunca lida ou anterior à migration. Em grupo fica nulo: o cap de ACK de grupo para em delivered.';
