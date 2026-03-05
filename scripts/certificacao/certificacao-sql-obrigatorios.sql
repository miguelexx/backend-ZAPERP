-- ============================================================
-- CERTIFICAÇÃO MULTI-TENANT Z-API — SQLs OBRIGATÓRIOS
-- Executar no Supabase SQL Editor para provar estado do banco
-- ============================================================

-- ========== DUPLICADOS (deve retornar 0 linhas em cada) ==========

-- Clientes duplicados por (company_id, telefone)
SELECT company_id, telefone, COUNT(*) AS total
FROM clientes
GROUP BY company_id, telefone
HAVING COUNT(*) > 1;

-- Conversas duplicadas por (company_id, telefone)
SELECT company_id, telefone, COUNT(*) AS total
FROM conversas
GROUP BY company_id, telefone
HAVING COUNT(*) > 1;

-- Mensagens duplicadas por (company_id, whatsapp_id)
SELECT company_id, whatsapp_id, COUNT(*) AS total
FROM mensagens
WHERE whatsapp_id IS NOT NULL
GROUP BY company_id, whatsapp_id
HAVING COUNT(*) > 1;

-- ========== PROVA company_id CORRETO ==========

-- Pegar um whatsapp_id de teste do company 2 e verificar:
-- SELECT company_id FROM mensagens WHERE whatsapp_id='<id>';
-- Deve retornar company_id=2

-- ========== PROVA CLIENTE AUTO-SALVO (nome/foto) ==========

-- Substituir <tail> pelos últimos dígitos do telefone de teste
-- SELECT company_id, telefone, nome, foto_perfil
-- FROM clientes
-- WHERE company_id=2 AND telefone LIKE '%<tail>%';

-- ========== AMOSTRA MENSAGENS COMPANY 2 ==========

-- SELECT company_id, conversa_id, whatsapp_id, texto, tipo, criado_em
-- FROM mensagens
-- WHERE company_id=2
-- ORDER BY criado_em DESC
-- LIMIT 20;
