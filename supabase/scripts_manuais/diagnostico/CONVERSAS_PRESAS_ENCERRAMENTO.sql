-- =====================================================================================
-- DIAGNÓSTICO: conversas que receberam a mensagem de encerramento automático mas
--              continuaram "Em atendimento"
-- =====================================================================================
-- Contexto (auditoria 16/10/2026):
--   `finalizeConversationsByAbsence` (services/absenceFinalizationService.js) fechava a conversa,
--   mandava a mensagem de encerramento e, se o provedor devolvesse QUALQUER falha, revertia a
--   conversa para `em_atendimento` — inclusive em falha TRANSITÓRIA (timeout/rede/429/5xx), em que
--   a mensagem muitas vezes JÁ TINHA SAÍDO (o cliente a recebe, ela ganha ✓✓ depois pelo ACK).
--
--   O efeito colateral grave: a bolha de encerramento ficava como ÚLTIMA mensagem da conversa.
--   Como ela não conta como "fala de atendente humano" (`isHumanAttendantLastOutbound`), nenhum
--   ciclo seguinte do scheduler reconhecia a conversa como candidata. Resultado: conversa presa em
--   "Em atendimento" PARA SEMPRE, com o atendente de volta e a mensagem de despedida no fim.
--
--   Correções de código (16/10, pendentes de deploy):
--     • falha transitória não reverte mais — conversa fica fechada e a mensagem fica pending para
--       a varredura de reconciliação;
--     • recusa definitiva reverte SEM gravar a bolha (o ciclo seguinte volta a enxergar a conversa);
--     • o scheduler passou a CONCLUIR sozinho os encerramentos interrompidos (auto-reparo do
--       passivo, ~5 min depois do deploy, sem reenviar mensagem nenhuma).
--
-- NATUREZA: consultas 1–3 são 100% SOMENTE LEITURA. A consulta 4 é o reparo manual (UPDATE) e só
--   deve ser usada se você NÃO for depender do auto-reparo (ex.: empresa com a finalização por
--   ausência desligada na tela — nesse caso o scheduler não toca nessas conversas).
-- ONDE RODAR: Supabase SQL Editor, um bloco por vez.
--
-- COMO USAR: edite só a linha marcada `<< EDITE` (array de company_id — o isolamento aqui é
--   app-layer, então o filtro por empresa é sempre explícito).
--
-- FUSO: `mensagens.criado_em` é timestamp WITHOUT time zone gravado em UTC; `conversas.
--   ultima_atividade` é WITH time zone. Não compare os dois sem `AT TIME ZONE 'UTC'`.
-- =====================================================================================


-- =====================================================================================
-- 1) Quantas vezes a reversão por falha de envio aconteceu (a origem do passivo)
-- =====================================================================================
WITH p AS (SELECT ARRAY[1]::int[] AS empresas)
SELECT
  date_trunc('day', h.criado_em)::date AS dia,
  COUNT(*)                             AS reversoes
FROM historico_atendimentos h
JOIN conversas c ON c.id = h.conversa_id
CROSS JOIN p
WHERE c.company_id = ANY(p.empresas)          -- << EDITE
  AND h.acao = 'encerramento_ausencia_falha_envio'
GROUP BY 1
ORDER BY 1 DESC;


-- =====================================================================================
-- 2) Conversas PRESAS hoje: "em atendimento", mas a última mensagem é a de encerramento
--    automático enviada pelo sistema (sem autor) e `ausencia_mensagem_enviada_em` está vazio.
--    Esta é exatamente a lista que o auto-reparo vai fechar depois do deploy.
-- =====================================================================================
WITH p AS (SELECT ARRAY[1]::int[] AS empresas),   -- << EDITE
cfg AS (
  SELECT
    i.company_id,
    NULLIF(btrim(i.config->'chatbot_triage'->>'finalizar_por_ausencia_mensagem'), '') AS msg_ausencia
  FROM ia_config i
  CROSS JOIN p
  WHERE i.company_id = ANY(p.empresas)
),
alvo AS (
  SELECT c.id, c.company_id, c.atendente_id, c.telefone, c.ultima_atividade, cfg.msg_ausencia
  FROM conversas c
  JOIN cfg ON cfg.company_id = c.company_id
  WHERE c.status_atendimento = 'em_atendimento'
    AND c.ausencia_mensagem_enviada_em IS NULL
    AND COALESCE(c.tipo, '') <> 'grupo'
)
SELECT
  a.company_id,
  a.id                          AS conversa_id,
  a.atendente_id,
  a.telefone,
  m.id                          AS mensagem_encerramento_id,
  m.criado_em                   AS encerramento_em_utc,
  m.status,
  m.status_mensagem,
  (now() AT TIME ZONE 'UTC' - m.criado_em) AS presa_ha
FROM alvo a
JOIN LATERAL (
  SELECT id, direcao, texto, criado_em, autor_usuario_id, status, status_mensagem
  FROM mensagens
  WHERE company_id = a.company_id AND conversa_id = a.id
  ORDER BY criado_em DESC, id DESC
  LIMIT 1
) m ON TRUE
WHERE m.direcao = 'out'
  AND m.autor_usuario_id IS NULL
  AND btrim(m.texto) IN (
    a.msg_ausencia,
    'Seu atendimento foi encerrado por falta de interação no momento. Caso precise continuar, basta nos enviar uma nova mensagem.'
  )
ORDER BY m.criado_em;


-- =====================================================================================
-- 3) Conferência pós-deploy: rode a consulta 2 de novo ~10 min depois do deploy.
--    O esperado é a lista esvaziar (o scheduler roda a cada 5 min, no máximo 12 por ciclo —
--    ABSENCE_FINALIZATION_MAX_PER_CYCLE). Para acompanhar o que o auto-reparo fez:
-- =====================================================================================
WITH p AS (SELECT ARRAY[1]::int[] AS empresas)   -- << EDITE
SELECT h.conversa_id, h.criado_em, h.acao
FROM historico_atendimentos h
JOIN conversas c ON c.id = h.conversa_id
CROSS JOIN p
WHERE c.company_id = ANY(p.empresas)
  AND h.acao IN ('encerramento_automatico_ausencia', 'encerramento_ausencia_envio_pendente')
  AND h.criado_em > now() - interval '1 day'
ORDER BY h.criado_em DESC
LIMIT 200;


-- =====================================================================================
-- 3.1) Segunda causa: conversas EM ATENDIMENTO com resíduo de encerramento automático.
--      O scan antigo excluía essas conversas para sempre (filtro por `finalizacao_motivo`).
--      Origem típica: novo disparo em conversa fechada (fechada → aberta sem limpar os campos)
--      e depois alguém assumiu. Somente leitura.
-- =====================================================================================
WITH p AS (SELECT ARRAY[1]::int[] AS empresas)   -- << EDITE
SELECT
  c.company_id,
  c.id AS conversa_id,
  c.atendente_id,
  c.finalizacao_motivo,
  c.finalizada_automaticamente,
  c.finalizada_automaticamente_em,
  c.ultima_atividade
FROM conversas c
CROSS JOIN p
WHERE c.company_id = ANY(p.empresas)
  AND c.status_atendimento = 'em_atendimento'
  AND (c.finalizacao_motivo = 'ausencia_cliente' OR c.finalizada_automaticamente_em IS NOT NULL)
ORDER BY c.ultima_atividade;
-- Depois do deploy esses campos são zerados sozinhos no primeiro ciclo em que a conversa
-- entra no scan (markWaitingForClient). Não precisa de UPDATE manual.


-- =====================================================================================
-- 4) REPARO MANUAL (OPCIONAL — só se não for esperar o auto-reparo)
-- =====================================================================================
-- Fecha as conversas da consulta 2 sem reenviar nada (a mensagem já está na conversa).
-- Confira a consulta 2 ANTES: este bloco fecha exatamente aquelas linhas.
-- Rode selecionando do BEGIN ao COMMIT.
/*
BEGIN;

WITH p AS (SELECT ARRAY[1]::int[] AS empresas),   -- << EDITE
cfg AS (
  SELECT
    i.company_id,
    NULLIF(btrim(i.config->'chatbot_triage'->>'finalizar_por_ausencia_mensagem'), '') AS msg_ausencia
  FROM ia_config i CROSS JOIN p
  WHERE i.company_id = ANY(p.empresas)
),
alvo AS (
  SELECT c.id, c.company_id, cfg.msg_ausencia
  FROM conversas c
  JOIN cfg ON cfg.company_id = c.company_id
  WHERE c.status_atendimento = 'em_atendimento'
    AND c.ausencia_mensagem_enviada_em IS NULL
    AND COALESCE(c.tipo, '') <> 'grupo'
),
presas AS (
  SELECT a.id, a.company_id, m.criado_em AS encerramento_em
  FROM alvo a
  JOIN LATERAL (
    SELECT direcao, texto, criado_em, autor_usuario_id
    FROM mensagens
    WHERE company_id = a.company_id AND conversa_id = a.id
    ORDER BY criado_em DESC, id DESC
    LIMIT 1
  ) m ON TRUE
  WHERE m.direcao = 'out'
    AND m.autor_usuario_id IS NULL
    AND btrim(m.texto) IN (
      a.msg_ausencia,
      'Seu atendimento foi encerrado por falta de interação no momento. Caso precise continuar, basta nos enviar uma nova mensagem.'
    )
)
UPDATE conversas c
SET status_atendimento            = 'fechada',
    finalizacao_motivo            = 'ausencia_cliente',
    finalizada_automaticamente    = true,
    finalizada_automaticamente_em = now(),
    ausencia_mensagem_enviada_em  = presas.encerramento_em,
    atendente_id                  = NULL,
    atendente_atribuido_em        = NULL
FROM presas
WHERE c.id = presas.id
  AND c.company_id = presas.company_id
  AND c.status_atendimento = 'em_atendimento';

-- Confira a contagem acima antes de confirmar.
COMMIT;
-- ROLLBACK;  -- use se o número não bater com a consulta 2
*/
