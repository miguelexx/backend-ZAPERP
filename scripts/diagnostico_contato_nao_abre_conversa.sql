-- =====================================================================
-- Diagnóstico: contato aparece na busca ("Sem conversa") mas ao clicar
-- devolve 500 "Não foi possível localizar ou criar conversa".
--
-- Doc: docs/ai-handoff/39-AUDITORIA-CONTATO-NAO-ABRE-CONVERSA.md
-- SOMENTE LEITURA. Nenhuma query abaixo escreve ou apaga.
-- Trocar :COMPANY_ID pelo company_id da empresa (ex.: 24).
--
-- Regra que o backend aplica (helpers/phoneHelper.js → normalizePhoneBR):
--   aceita  →  10 ou 11 dígitos  |  55 + 10 dígitos (12)  |  55 + 11 dígitos (13)
--              |  grupo 120… com 15+ dígitos
--   rejeita →  TODO o resto  → getCanonicalPhone devolve ''
--              → findOrCreateConversation devolve null → 500
-- =====================================================================


-- ---------------------------------------------------------------------
-- A) OS CONTATOS QUEBRADOS — a lista exata que dá 500 ao clicar
-- ---------------------------------------------------------------------
WITH c AS (
  SELECT id, nome, telefone, wa_id, criado_em,
         regexp_replace(COALESCE(telefone, ''), '\D', '', 'g') AS dig
  FROM clientes
  WHERE company_id = :COMPANY_ID
    AND COALESCE(telefone, '') NOT LIKE '%@g.us'
)
SELECT
  id,
  nome,
  telefone,
  length(dig)                      AS digitos,
  CASE
    WHEN dig LIKE '550%'                        THEN 'DDI 55 + DDD com 0 na frente'
    WHEN dig LIKE '0%'                          THEN 'DDD com 0 na frente (sem DDI)'
    WHEN length(dig) IN (12, 13)                THEN 'nao comeca com 55 (internacional?)'
    WHEN length(dig) > 13                       THEN 'digitos demais'
    ELSE                                             'outro formato'
  END                              AS diagnostico,
  wa_id,
  criado_em
FROM c
WHERE dig <> ''
  AND length(dig) NOT IN (10, 11)
  AND NOT (dig LIKE '55%'  AND length(dig) IN (12, 13))
  AND NOT (dig LIKE '120%' AND length(dig) >= 15)
ORDER BY criado_em DESC NULLS LAST, id DESC;


-- ---------------------------------------------------------------------
-- B) QUANTOS SÃO, agrupados por formato e por dia de criação
--    (dia em bloco = veio de uma sincronização de contatos)
-- ---------------------------------------------------------------------
WITH c AS (
  SELECT id, criado_em,
         regexp_replace(COALESCE(telefone, ''), '\D', '', 'g') AS dig
  FROM clientes
  WHERE company_id = :COMPANY_ID
    AND COALESCE(telefone, '') NOT LIKE '%@g.us'
)
SELECT
  date(criado_em)  AS dia_criacao,
  length(dig)      AS digitos,
  left(dig, 3)     AS prefixo,
  count(*)         AS qtd
FROM c
WHERE dig <> ''
  AND length(dig) NOT IN (10, 11)
  AND NOT (dig LIKE '55%'  AND length(dig) IN (12, 13))
  AND NOT (dig LIKE '120%' AND length(dig) >= 15)
GROUP BY 1, 2, 3
ORDER BY 1 DESC NULLS LAST, 4 DESC;


-- ---------------------------------------------------------------------
-- C) O CONTATO QUEBRADO É DUPLICATA DO CONTATO BOM?
--    Casa pelos 8 últimos dígitos: mostra o par (quebrado × real).
--    Se o "bom" existir, o quebrado é lixo de importação e pode sair.
-- ---------------------------------------------------------------------
WITH c AS (
  SELECT id, nome, telefone, criado_em,
         regexp_replace(COALESCE(telefone, ''), '\D', '', 'g') AS dig
  FROM clientes
  WHERE company_id = :COMPANY_ID
    AND COALESCE(telefone, '') NOT LIKE '%@g.us'
),
quebrados AS (
  SELECT * FROM c
  WHERE dig <> ''
    AND length(dig) NOT IN (10, 11)
    AND NOT (dig LIKE '55%'  AND length(dig) IN (12, 13))
    AND NOT (dig LIKE '120%' AND length(dig) >= 15)
),
bons AS (
  SELECT * FROM c
  WHERE length(dig) IN (10, 11)
     OR (dig LIKE '55%' AND length(dig) IN (12, 13))
)
SELECT
  q.id        AS cliente_quebrado_id,
  q.nome      AS nome_quebrado,
  q.telefone  AS telefone_quebrado,
  q.criado_em AS criado_quebrado,
  b.id        AS cliente_bom_id,
  b.nome      AS nome_bom,
  b.telefone  AS telefone_bom,
  (SELECT count(*) FROM conversas cv
    WHERE cv.company_id = :COMPANY_ID AND cv.cliente_id = b.id) AS conversas_do_bom,
  (SELECT count(*) FROM conversas cv
    WHERE cv.company_id = :COMPANY_ID AND cv.cliente_id = q.id) AS conversas_do_quebrado
FROM quebrados q
LEFT JOIN bons b
  ON right(b.dig, 8) = right(q.dig, 8)
ORDER BY q.criado_em DESC NULLS LAST, q.id DESC;


-- ---------------------------------------------------------------------
-- D) O CASO DA TELA — trocar o termo se o nome for outro
-- ---------------------------------------------------------------------
-- (a seção E, opcional e de ESCRITA, vem depois desta)
SELECT
  id,
  nome,
  telefone,
  length(regexp_replace(COALESCE(telefone, ''), '\D', '', 'g')) AS digitos,
  wa_id,
  criado_em,
  (SELECT count(*) FROM conversas cv
    WHERE cv.company_id = :COMPANY_ID AND cv.cliente_id = clientes.id) AS qtd_conversas
FROM clientes
WHERE company_id = :COMPANY_ID
  AND lower(COALESCE(nome, '')) LIKE '%alessandro%'
ORDER BY id;


-- =====================================================================
-- E) OPCIONAL — LIMPEZA DO TRONCO "0" NOS REGISTROS JÁ GRAVADOS
--
-- ⚠️ ESTA É A ÚNICA SEÇÃO QUE ESCREVE. Tudo acima é leitura.
-- Depois do deploy da correção (doc 39 §7) o contato com tronco "0" JÁ ABRE a conversa
-- certa sem tocar no banco — esta seção serve só para arrumar o cadastro em si.
--
-- Regras de segurança embutidas:
--   • só mexe em telefone que começa com "0" ou "550" (tronco comprovado);
--   • só grava se o número corrigido virar 55 + DDD de 1 a 9 + 8/9 dígitos;
--   • NÃO toca em linha cujo número corrigido já exista na empresa (evita violar o
--     UNIQUE company_id+telefone e evita fundir dois cadastros sem conferência).
--     Essas linhas são duplicatas — trate-as pela seção C, não aqui.
-- =====================================================================

-- E.1) PREVIEW — rode primeiro e confira linha a linha. Não altera nada.
WITH c AS (
  SELECT id, nome, telefone, company_id,
         regexp_replace(COALESCE(telefone, ''), '\D', '', 'g') AS dig
  FROM clientes
  WHERE company_id = :COMPANY_ID
    AND COALESCE(telefone, '') NOT LIKE '%@g.us'
),
corrigidos AS (
  SELECT id, nome, telefone, company_id, dig,
         CASE
           WHEN dig LIKE '550%' THEN '55' || ltrim(substr(dig, 3), '0')
           WHEN dig LIKE '0%'   THEN '55' || ltrim(dig, '0')
         END AS novo
  FROM c
  WHERE dig LIKE '0%' OR dig LIKE '550%'
)
SELECT
  id,
  nome,
  telefone        AS telefone_atual,
  novo            AS telefone_corrigido,
  CASE
    WHEN novo !~ '^55[1-9][0-9]{9,10}$' THEN 'NAO CORRIGIR — formato ainda inválido'
    WHEN EXISTS (
      SELECT 1 FROM clientes x
      WHERE x.company_id = corrigidos.company_id
        AND regexp_replace(COALESCE(x.telefone, ''), '\D', '', 'g') = corrigidos.novo
    )                                    THEN 'NAO CORRIGIR — já existe contato com esse número (duplicata: ver seção C)'
    ELSE                                      'PODE CORRIGIR'
  END AS decisao
FROM corrigidos
ORDER BY decisao, id;

-- E.2) APLICAR — só depois de conferir o preview acima.
--      Descomente o bloco inteiro para rodar.
--      Se DUAS linhas quebradas corrigirem para o MESMO número, o UNIQUE
--      (company_id, telefone) aborta a transação inteira e nada é gravado — falha segura.
--      Nesse caso resolva primeiro as duplicatas pela seção C.
/*
UPDATE clientes AS alvo
SET telefone = calc.novo
FROM (
  SELECT id, company_id,
         CASE
           WHEN dig LIKE '550%' THEN '55' || ltrim(substr(dig, 3), '0')
           WHEN dig LIKE '0%'   THEN '55' || ltrim(dig, '0')
         END AS novo
  FROM (
    SELECT id, company_id, regexp_replace(COALESCE(telefone, ''), '\D', '', 'g') AS dig
    FROM clientes
    WHERE company_id = :COMPANY_ID
      AND COALESCE(telefone, '') NOT LIKE '%@g.us'
  ) base
  WHERE dig LIKE '0%' OR dig LIKE '550%'
) AS calc
WHERE alvo.id = calc.id
  AND alvo.company_id = :COMPANY_ID
  AND calc.novo ~ '^55[1-9][0-9]{9,10}$'
  AND NOT EXISTS (
    SELECT 1 FROM clientes x
    WHERE x.company_id = calc.company_id
      AND regexp_replace(COALESCE(x.telefone, ''), '\D', '', 'g') = calc.novo
  );
*/
