-- =====================================================================================
-- DIAGNÓSTICO: "mostra enviada mas não foi" — endereço de destino corrompido pelo `55`
--
-- Laudo completo: docs/ai-handoff/38-AUDITORIA-ENDERECO-DESTINO-CORROMPIDO.md
--
-- Contexto curto: normalizePhoneBR (helpers/phoneHelper.js:32) prefixa `55` em QUALQUER
-- número de 10 ou 11 dígitos. Um celular francês +33 780259005 (11 dígitos) virou
-- 5533780259005; a Whapi aceita o POST, devolve um id e a mensagem fica `pending` para
-- sempre. Como existe `whatsapp_id`, a bolha desenha ✓ ("enviada").
--
-- Na Whapi: `pending` = aceita e NUNCA transmitida.  `sent` = saiu, falta o aparelho.
--
-- COMO RODAR (Supabase SQL Editor): selecione UM bloco por vez e execute — o editor só
-- mostra o resultado da última instrução. As consultas 1 a 4 são SOMENTE LEITURA.
-- A 5 é reparo e está comentada: leia o aviso antes.
-- =====================================================================================


-- =====================================================================================
-- 1) O SINTOMA — mensagens que o atendente vê como "enviada" e o provedor nunca transmitiu
--    (status 'pending' COM id do provedor). Agrupado por conversa.
-- =====================================================================================
SELECT
  m.company_id,
  e.nome                                   AS empresa,
  m.conversa_id,
  c.telefone                               AS endereco_usado_no_envio,
  COALESCE(c.nome_contato_cache, cl.nome)  AS contato,
  COUNT(*)                                 AS msgs_presas,
  MIN(m.criado_em)                         AS mais_antiga,
  MAX(m.criado_em)                         AS mais_recente,
  NOW() - MIN(m.criado_em)                 AS presa_ha,
  CASE
    WHEN c.tipo = 'grupo' OR c.telefone LIKE '%@g.us'        THEN 'grupo'
    WHEN c.telefone ~ '^55[1-9][0-9]9[0-9]{8}$'              THEN 'celular BR valido'
    WHEN c.telefone ~ '^55[1-9][0-9][2-5][0-9]{7}$'          THEN 'FIXO BR — provavelmente sem WhatsApp'
    WHEN c.telefone ~ '^55[0-9]{11}$'                        THEN '>>> SUSPEITA: 55 colado em numero estrangeiro'
    ELSE 'fora dos padroes conhecidos'
  END                                      AS diagnostico
FROM mensagens m
JOIN conversas  c  ON c.id  = m.conversa_id
LEFT JOIN clientes cl ON cl.id = c.cliente_id
LEFT JOIN empresas e  ON e.id  = m.company_id
WHERE m.direcao     = 'out'
  AND m.status      = 'pending'
  AND m.whatsapp_id IS NOT NULL
  AND m.criado_em  >= NOW() - INTERVAL '60 days'
GROUP BY m.company_id, e.nome, m.conversa_id, c.telefone, c.tipo,
         COALESCE(c.nome_contato_cache, cl.nome)
ORDER BY msgs_presas DESC, mais_recente DESC;


-- =====================================================================================
-- 2) A ASSINATURA DA CORRUPÇÃO — 13 dígitos começando em 55 cujo número local NÃO começa
--    com 9. Não pode ser celular BR; é `55` colado em número estrangeiro (ou lixo).
--
--    Medido em 05/11/2026: 75 conversas em 32.411 (mais 1 de tronco "0", excluída aqui).
--
--    NÃO existe detector de forma para o caso de 12 dígitos (55 + 10): essa é a forma
--    legítima do celular BR sem o 9 (26 mil linhas). Para esses, só a consulta 4 resolve.
-- =====================================================================================
SELECT
  c.company_id,
  e.nome                                   AS empresa,
  c.id                                     AS conversa_id,
  c.telefone                               AS endereco_usado_no_envio,
  SUBSTR(c.telefone, 3)                    AS endereco_provavel_sem_o_55,
  COALESCE(c.nome_contato_cache, cl.nome)  AS contato,
  cl.wa_id                                 AS jid_conhecido,
  c.ultima_atividade
FROM conversas c
LEFT JOIN clientes cl ON cl.id = c.cliente_id
LEFT JOIN empresas e  ON e.id  = c.company_id
WHERE c.tipo <> 'grupo'
  AND c.telefone ~ '^55[0-9]{11}$'
  -- Mesma regra do código (helpers/phoneHelper.podeSerCelularBrSemDdi): só é celular BR
  -- quando o número local começa com `9` E o DDD existe. O resto é DDI estrangeiro.
  AND NOT (SUBSTR(c.telefone, 5, 1) = '9' AND SUBSTR(c.telefone, 3, 2) IN (
      '11','12','13','14','15','16','17','18','19','21','22','24','27','28',
      '31','32','33','34','35','37','38','41','42','43','44','45','46','47','48','49',
      '51','53','54','55','61','62','63','64','65','66','67','68','69',
      '71','73','74','75','77','79','81','82','83','84','85','86','87','88','89',
      '91','92','93','94','95','96','97','98','99'))
  -- `550…` é tronco "0" depois do DDI, família do doc 39 — NÃO é número estrangeiro.
  AND c.telefone NOT LIKE '550%'
ORDER BY c.ultima_atividade DESC NULLS LAST;


-- =====================================================================================
-- 3) PRIORIDADE DE REPARO — cruzamento de 1 e 2: endereço suspeito E mensagem não entregue.
--    Estas são as conversas onde o cliente ficou sem resposta sem ninguém perceber.
-- =====================================================================================
SELECT
  c.company_id,
  e.nome                                   AS empresa,
  c.id                                     AS conversa_id,
  c.telefone                               AS endereco_usado_no_envio,
  SUBSTR(c.telefone, 3)                    AS endereco_provavel_sem_o_55,
  COALESCE(c.nome_contato_cache, cl.nome)  AS contato,
  COUNT(m.id)                              AS msgs_nunca_entregues,
  MIN(m.criado_em)                         AS primeira_perdida,
  MAX(m.criado_em)                         AS ultima_perdida
FROM conversas c
JOIN mensagens m
  ON m.conversa_id = c.id
 AND m.direcao      = 'out'
 AND m.status       = 'pending'
 AND m.whatsapp_id IS NOT NULL
LEFT JOIN clientes cl ON cl.id = c.cliente_id
LEFT JOIN empresas e  ON e.id  = c.company_id
WHERE c.tipo <> 'grupo'
  AND c.telefone ~ '^55[0-9]{11}$'
  -- Mesma regra do código (helpers/phoneHelper.podeSerCelularBrSemDdi): só é celular BR
  -- quando o número local começa com `9` E o DDD existe. O resto é DDI estrangeiro.
  AND NOT (SUBSTR(c.telefone, 5, 1) = '9' AND SUBSTR(c.telefone, 3, 2) IN (
      '11','12','13','14','15','16','17','18','19','21','22','24','27','28',
      '31','32','33','34','35','37','38','41','42','43','44','45','46','47','48','49',
      '51','53','54','55','61','62','63','64','65','66','67','68','69',
      '71','73','74','75','77','79','81','82','83','84','85','86','87','88','89',
      '91','92','93','94','95','96','97','98','99'))
  -- `550…` é tronco "0" depois do DDI, família do doc 39 — NÃO é número estrangeiro.
  AND c.telefone NOT LIKE '550%'
GROUP BY c.company_id, e.nome, c.id, c.telefone,
         COALESCE(c.nome_contato_cache, cl.nome)
ORDER BY msgs_nunca_entregues DESC;


-- =====================================================================================
-- 4) FORENSE POR CONVERSA — qual é o endereço REAL do contato, segundo o provedor.
--
--    Única fonte do `chat_id` verdadeiro.
--
--    A comparação CERTA não é "endereco_real × telefone da conversa" — é
--    "endereço que o CONTATO usa (from_me=false)" × "endereço que o ZapERP usa para enviar
--    (from_me=true AND source='api')". A primeira versão desta consulta comparava com o
--    telefone armazenado e, por isso, carimbava `ok` justamente na linha do endereço
--    fantasma (ele é igual ao telefone corrompido). Corrigido em 05/11/2026.
--
--    `source` do provedor: 'mobile' = saiu do aparelho | 'web' = WhatsApp Web |
--    'api' = saiu do ZapERP | 'system' = evento de sistema (criptografia, ações).
--
--    CUSTO: webhook_logs tem ~519 mil linhas (~414 mil nos últimos 14 dias) e o payload é
--    jsonb — esta consulta expande arrays. SEMPRE deixe os dois filtros abaixo preenchidos
--    e a janela curta. Não rodar sem company_id.
--
--    Exemplo usado no laudo: company_id = 24, janela de 04/11 a 05/11.
-- =====================================================================================
-- O MATERIALIZED é obrigatório: sem ele o planner pode empurrar o JSONB_ARRAY_ELEMENTS
-- para linhas cujo `messages` é objeto (eventos de chats/statuses) e a consulta aborta
-- com "cannot extract elements from an object".
--
-- `candidatos` existe porque o telefone guardado pode diferir do endereço real por DOIS
-- motivos legítimos, e só um deles é defeito:
--   a) '55' colado na frente  -> é o defeito desta auditoria;
--   b) nono dígito a mais/a menos -> inofensivo, o resolvedor da Whapi acerta o destino.
-- Sem as formas ±9 o JOIN falha e a conversa aparece como inexistente (falso alarme).
WITH eventos AS MATERIALIZED (
  SELECT w.company_id, w.criado_em, w.payload -> 'messages' AS msgs
  FROM webhook_logs w
  WHERE w.provider    = 'whapi'
    AND w.company_id  = 24                                   -- <<< AJUSTE
    AND w.criado_em  >= TIMESTAMPTZ '2026-11-04 00:00:00+00'  -- <<< AJUSTE
    AND w.criado_em  <  TIMESTAMPTZ '2026-11-06 00:00:00+00'  -- <<< AJUSTE
    AND JSONB_TYPEOF(w.payload -> 'messages') = 'array'
),
itens AS (
  SELECT
    ev.company_id,
    ev.criado_em,
    SPLIT_PART(msg ->> 'chat_id', '@', 1)           AS endereco,
    COALESCE((msg ->> 'from_me')::boolean, FALSE)   AS from_me,
    msg ->> 'source'                                AS origem_provedor
  FROM eventos ev
  CROSS JOIN LATERAL JSONB_ARRAY_ELEMENTS(ev.msgs) AS msg
  WHERE msg ->> 'chat_id' LIKE '%@s.whatsapp.net'
),
candidatos AS (
  SELECT i.*, cand
  FROM itens i
  CROSS JOIN LATERAL UNNEST(ARRAY[
    i.endereco,
    '55' || i.endereco,
    CASE WHEN i.endereco ~ '^55[0-9]{10}$'
         THEN SUBSTR(i.endereco, 1, 4) || '9' || SUBSTR(i.endereco, 5) END,
    CASE WHEN i.endereco ~ '^55[0-9]{11}$' AND SUBSTR(i.endereco, 5, 1) = '9'
         THEN SUBSTR(i.endereco, 1, 4) || SUBSTR(i.endereco, 6) END
  ]) AS cand
  WHERE cand IS NOT NULL
),
por_conversa AS (
  SELECT
    c.company_id,
    c.id                                     AS conversa_id,
    c.telefone                               AS endereco_usado_no_envio,
    COALESCE(c.nome_contato_cache, cl.nome)  AS contato,
    COUNT(DISTINCT k.endereco)               AS enderecos_distintos,
    STRING_AGG(DISTINCT CASE WHEN NOT k.from_me THEN k.endereco END, ', ')             AS endereco_do_contato,
    STRING_AGG(DISTINCT CASE WHEN k.from_me AND k.origem_provedor = 'api'
                             THEN k.endereco END, ', ')                                AS endereco_usado_pela_api,
    STRING_AGG(DISTINCT CASE WHEN k.from_me AND k.origem_provedor IN ('mobile', 'web')
                             THEN k.endereco END, ', ')                                AS endereco_usado_pelo_aparelho,
    MAX(k.criado_em)                         AS visto_em
  FROM candidatos k
  JOIN conversas c ON c.company_id = k.company_id AND c.telefone = k.cand
  LEFT JOIN clientes cl ON cl.id = c.cliente_id
  GROUP BY 1, 2, 3, 4
)
SELECT
  p.*,
  CASE
    WHEN p.enderecos_distintos > 1 THEN '>>> DIVERGENTE — a API fala com outro endereco'
    ELSE 'ok'
  END AS veredito
FROM por_conversa p
ORDER BY p.enderecos_distintos DESC, p.visto_em DESC;


-- =====================================================================================
-- 4b) Endereços vistos no provedor SEM conversa correspondente.
--
--     Na empresa 24, em 04-05/11, isto deu 2 contatos e o motivo era inocente: a conversa
--     foi APAGADA depois. `services/chat/deletion/conversationDeletionService.js:83` dá
--     DELETE em `conversas` e o cleanup dá DELETE em `mensagens`; o `clientes` sobrevive.
--     A prova de que não houve perda é o `ultimo_contato` do cliente bater com o horário
--     do último webhook — o inbound rodou e atualizou o contato.
--
--     Só tratar como perda de mensagem quando o cliente NÃO existir, ou quando o
--     `ultimo_contato` estiver atrasado em relação ao último evento do provedor.
-- =====================================================================================
WITH eventos AS MATERIALIZED (
  SELECT w.company_id, w.criado_em, w.payload -> 'messages' AS msgs
  FROM webhook_logs w
  WHERE w.provider    = 'whapi'
    AND w.company_id  = 24                                   -- <<< AJUSTE
    AND w.criado_em  >= TIMESTAMPTZ '2026-11-04 00:00:00+00'  -- <<< AJUSTE
    AND w.criado_em  <  TIMESTAMPTZ '2026-11-06 00:00:00+00'  -- <<< AJUSTE
    AND JSONB_TYPEOF(w.payload -> 'messages') = 'array'
),
itens AS (
  SELECT ev.company_id, ev.criado_em,
         SPLIT_PART(msg ->> 'chat_id', '@', 1) AS endereco
  FROM eventos ev
  CROSS JOIN LATERAL JSONB_ARRAY_ELEMENTS(ev.msgs) AS msg
  WHERE msg ->> 'chat_id' LIKE '%@s.whatsapp.net'
),
orfaos AS (
  SELECT i.company_id, i.endereco, MAX(i.criado_em) AS visto_em, COUNT(*) AS eventos
  FROM itens i
  GROUP BY 1, 2
)
SELECT
  o.company_id,
  o.endereco              AS endereco_real,
  o.eventos,
  o.visto_em,
  cl.id                   AS cliente_id,
  cl.nome                 AS contato,
  cl.telefone             AS telefone_do_cliente,
  cl.ultimo_contato,
  CASE
    WHEN cl.id IS NULL                                        THEN '>>> nem cliente existe — investigar'
    WHEN cl.ultimo_contato >= o.visto_em - INTERVAL '2 min'   THEN 'conversa apagada depois (cliente atualizado na hora certa)'
    ELSE '>>> cliente desatualizado — investigar'
  END                     AS leitura
FROM orfaos o
LEFT JOIN clientes cl
       ON cl.company_id = o.company_id
      AND cl.telefone IN (
            o.endereco,
            '55' || o.endereco,
            CASE WHEN o.endereco ~ '^55[0-9]{10}$'
                 THEN SUBSTR(o.endereco, 1, 4) || '9' || SUBSTR(o.endereco, 5) END,
            CASE WHEN o.endereco ~ '^55[0-9]{11}$' AND SUBSTR(o.endereco, 5, 1) = '9'
                 THEN SUBSTR(o.endereco, 1, 4) || SUBSTR(o.endereco, 6) END
          )
WHERE NOT EXISTS (
  SELECT 1 FROM conversas c
  WHERE c.company_id = o.company_id
    AND c.telefone IN (
          o.endereco,
          '55' || o.endereco,
          CASE WHEN o.endereco ~ '^55[0-9]{10}$'
               THEN SUBSTR(o.endereco, 1, 4) || '9' || SUBSTR(o.endereco, 5) END,
          CASE WHEN o.endereco ~ '^55[0-9]{11}$' AND SUBSTR(o.endereco, 5, 1) = '9'
               THEN SUBSTR(o.endereco, 1, 4) || SUBSTR(o.endereco, 6) END
        )
)
ORDER BY o.visto_em DESC;


-- =====================================================================================
-- 5) REPARO PONTUAL — SÓ DEPOIS DO DEPLOY DO FIX DE CÓDIGO.
--
--    >>> ORDEM OBRIGATÓRIA: deploy do backend primeiro, SQL depois.
--    >>> O fix está no código (doc 38 §7) mas NÃO está deployado. Em produção o
--    >>> `normalizePhoneBR` ainda transforma 33780259005 em 5533780259005: trocar o
--    >>> telefone agora faria a próxima mensagem do cliente abrir uma SEGUNDA conversa.
--    >>> Com o fix no ar isso não acontece — `possiblePhonesBR` passa a devolver também
--    >>> a forma legada com `55`, então a conversa antiga continua sendo encontrada
--    >>> mesmo antes de o telefone ser reescrito aqui.
--
--    O que o deploy do código resolve sozinho: todo contato internacional NOVO entra com
--    o endereço certo. O que ele NÃO resolve: as linhas já gravadas — o envio continua
--    saindo para `conversas.telefone`, que ainda tem o `55` indevido. É este bloco.
--
--    Passivo medido em 05/11/2026: 75 conversas em 13 empresas (a consulta 2 lista).
--
--    Unicidade: (company_id, telefone) em clientes e conversas — conferido, sem colisão
--    para o caso 42180 em 05/11/2026. Reconfira com a consulta de pré-checagem abaixo.
--
--    Pré-checagem (SOMENTE LEITURA — pode rodar à vontade):
--
-- SELECT 'cliente'  AS tabela, id, telefone FROM clientes  WHERE company_id = 24 AND telefone IN ('33780259005','5533780259005')
-- UNION ALL
-- SELECT 'conversa' AS tabela, id, telefone FROM conversas WHERE company_id = 24 AND telefone IN ('33780259005','5533780259005');
--
--    Reparo (depois do DEPLOY do fix, um contato por vez — nunca em lote cego: cada
--    número precisa de um olhar, porque `55` + DDI é indistinguível de celular BR em
--    alguns casos de 12 dígitos e porque `550…` é tronco "0", não estrangeiro):
--
-- UPDATE clientes  SET telefone = '33780259005', wa_id = '33780259005@s.whatsapp.net'
--  WHERE company_id = 24 AND id = 1145258 AND telefone = '5533780259005';
--
-- UPDATE conversas SET telefone = '33780259005'
--  WHERE company_id = 24 AND id = 42180   AND telefone = '5533780259005';
--
--    As 9 mensagens presas NÃO devem ser reenviadas por aqui: o endereço antigo continua
--    gravado em mensagens.whatsapp_id e a varredura não reenvia linha que o provedor
--    aceitou (exige provedorNuncaAceitou). O reenvio é manual, pela tela, depois do fix.
--
--    Se quiser que a bolha pare de mentir enquanto o fix de UI não sai, marcar como erro
--    só as linhas desta conversa (visível para o atendente como falha, que é a verdade):
--
-- UPDATE mensagens SET status = 'erro', status_mensagem = 'failed'
--  WHERE company_id = 24 AND conversa_id = 42180
--    AND direcao = 'out' AND status = 'pending' AND whatsapp_id IS NOT NULL;
-- =====================================================================================
