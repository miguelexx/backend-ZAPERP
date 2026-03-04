-- ============================================================
-- E) Anti-duplicação — Verificação para Relatório de Certificação
-- Executar e provar 0 duplicados por empresa.
-- ============================================================

-- E1) Conversas duplicadas por telefone (deve retornar 0 linhas)
SELECT company_id, telefone, COUNT(*) AS total
FROM conversas
WHERE telefone IS NOT NULL AND telefone <> ''
GROUP BY 1, 2
HAVING COUNT(*) > 1;

-- E2) Clientes duplicados por telefone (deve retornar 0 linhas)
SELECT company_id, telefone, COUNT(*) AS total
FROM clientes
WHERE telefone IS NOT NULL AND telefone <> ''
GROUP BY 1, 2
HAVING COUNT(*) > 1;

-- E3) Mensagens duplicadas por whatsapp_id (deve retornar 0 linhas)
SELECT company_id, whatsapp_id, COUNT(*) AS total
FROM mensagens
WHERE whatsapp_id IS NOT NULL AND whatsapp_id <> ''
GROUP BY 1, 2
HAVING COUNT(*) > 1;
