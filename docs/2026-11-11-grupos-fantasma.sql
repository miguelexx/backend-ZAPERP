-- =============================================================================
-- 11/11/2026 — conversas de grupo FANTASMA (telefone `grupo_<timestamp>`)
--
-- Causa (já corrigida no código): `criarGrupo` lia `conv?.id` do
-- findOrCreateConversation, que devolve `{ conversa, created }`. Dava sempre
-- undefined, caía no insert de emergência e TODO grupo criado pelo sistema
-- nascia em duas linhas: a certa (telefone 120...@g.us) e uma fantasma, que era
-- justamente a devolvida para a tela.
--
-- A fantasma não aponta para grupo nenhum: mensagem enviada nela não sai no
-- WhatsApp. Rodar NO SUPABASE SQL EDITOR, bloco a bloco, conferindo os SELECTs.
-- =============================================================================

-- 1) Quem são (5 linhas no levantamento de 10/11, empresas 4 e 25):
SELECT c.id, c.company_id, c.nome_grupo, c.telefone, c.criado_em,
       (SELECT COUNT(*) FROM mensagens m
         WHERE m.company_id = c.company_id AND m.conversa_id = c.id) AS msgs,
       (SELECT COUNT(*) FROM conversas r
         WHERE r.company_id = c.company_id AND r.tipo = 'grupo'
           AND r.nome_grupo = c.nome_grupo AND r.telefone NOT LIKE 'grupo\_%') AS tem_conversa_real
FROM conversas c
WHERE c.telefone LIKE 'grupo\_%'
ORDER BY c.company_id, c.nome_grupo;

-- 2) Apagar SÓ as fantasmas SEM mensagem e que já têm a conversa real do mesmo
--    grupo. As que têm mensagem ficam de fora de propósito: a mensagem não foi
--    entregue a ninguém, mas o texto é seu e a decisão de descartar é sua.
DELETE FROM conversas c
WHERE c.telefone LIKE 'grupo\_%'
  AND NOT EXISTS (
    SELECT 1 FROM mensagens m
     WHERE m.company_id = c.company_id AND m.conversa_id = c.id
  )
  AND EXISTS (
    SELECT 1 FROM conversas r
     WHERE r.company_id = c.company_id AND r.tipo = 'grupo'
       AND r.nome_grupo = c.nome_grupo
       AND r.telefone NOT LIKE 'grupo\_%'
  );

-- 3) O que sobrou (fantasmas com mensagem, ou sem par real). Veja uma a uma:
--    se o grupo existe mesmo no WhatsApp, use "Sincronizar todos os grupos" para
--    trazer a conversa real e depois apague a fantasma pela tela.
SELECT c.id, c.company_id, c.nome_grupo, c.telefone,
       (SELECT COUNT(*) FROM mensagens m
         WHERE m.company_id = c.company_id AND m.conversa_id = c.id) AS msgs
FROM conversas c
WHERE c.telefone LIKE 'grupo\_%'
ORDER BY c.company_id;
