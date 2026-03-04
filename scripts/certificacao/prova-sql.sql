-- ============================================================
-- SQLs DE PROVA — Certificação WhatsApp Web-like e Dedupe
-- Executar após testes e incluir resultado no documento PASS/FAIL
-- Substituir "1" pelo company_id real antes de rodar
-- ============================================================

-- A) Duplicados conversas por telefone (deve retornar 0 linhas)
SELECT company_id, telefone, count(*) AS total
FROM conversas
WHERE telefone IS NOT NULL AND telefone <> ''
GROUP BY company_id, telefone
HAVING count(*) > 1;

-- B) Mensagens duplicadas por whatsapp_id (deve retornar 0 linhas)
SELECT company_id, whatsapp_id, count(*) AS total
FROM mensagens
WHERE whatsapp_id IS NOT NULL AND whatsapp_id <> ''
GROUP BY company_id, whatsapp_id
HAVING count(*) > 1;

-- C) Contatos sem nome ou foto (para auditoria de enriquecimento)
SELECT company_id, telefone, nome, foto_perfil
FROM clientes
WHERE (nome IS NULL OR nome = '') OR (foto_perfil IS NULL OR foto_perfil = '')
ORDER BY company_id, telefone
LIMIT 50;
