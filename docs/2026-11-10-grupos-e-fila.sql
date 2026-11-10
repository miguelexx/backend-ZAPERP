-- =============================================================================
-- 10/11/2026 — dois reparos de dados, para rodar NO SUPABASE SQL EDITOR
-- APÓS o deploy do backend. Cada bloco tem um SELECT de conferência antes.
-- Rode um bloco de cada vez e confira o resultado do SELECT antes do UPDATE.
-- =============================================================================


-- =============================================================================
-- BLOCO 0 — FREIO. Rode AGORA se a fila foi reaberta ANTES do deploy.
-- O worker antigo manda o número com o 9º dígito e vai falhar nas 5 tentativas
-- de cada item (até 25 chamadas reais de "adicionar ao grupo" no seu número).
-- Pausar NÃO perde nada: os itens ficam pendentes esperando.
-- =============================================================================

UPDATE comunidade_operacoes
SET status = 'pausada',
    pausa_motivo = 'aguardando deploy da correcao do 9o digito',
    updated_at = NOW()
WHERE status = 'em_execucao';

-- confira (todas devem sair como 'pausada'):
SELECT comunidade_nome, status, pausa_motivo, total, concluidos, falhados
FROM comunidade_operacoes ORDER BY updated_at DESC;


-- =============================================================================
-- BLOCO 0-B — RETOMAR, só DEPOIS que o backend novo estiver no ar.
-- =============================================================================

UPDATE comunidade_fila_itens
SET tentativas = 0,
    status = 'pendente',
    resultado = NULL,
    erro_codigo = NULL,
    erro_mensagem = NULL,
    concluido_em = NULL,
    proxima_tentativa_em = NOW(),
    worker_id = NULL,
    lease_inicio = NULL,
    lease_ate = NULL,
    updated_at = NOW()
WHERE status IN ('pendente', 'falhou', 'reservada', 'enviando');

UPDATE comunidade_operacoes
SET status = 'em_execucao',
    pausa_motivo = NULL,
    concluidos = 0,
    falhados = 0,
    updated_at = NOW()
WHERE status = 'pausada';


-- -----------------------------------------------------------------------------
-- BLOCO 1 — carimbar a instância nos grupos antigos (whatsapp_instance_id NULL)
-- -----------------------------------------------------------------------------
-- Por quê: grupos importados antes do escopo por número ficaram com instância
-- nula. O filtro de visibilidade por número usa `IN (ids)`, e NULL nunca casa
-- um IN — então, no dia em que a visibilidade por número for ligada, esses
-- grupos somem para os usuários restritos. O sync novo carimba sozinho na
-- próxima passada; isto só antecipa.
--
-- Segurança: SÓ empresas com UM número ativo. Com 2+ não dá para saber de qual
-- número o grupo veio, e chutar seria pior do que deixar nulo.

-- 1.1 — confira ANTES (quantos e de quem):
SELECT c.company_id, i.id AS instancia, COUNT(*) AS grupos_sem_instancia
FROM conversas c
JOIN (
  SELECT company_id, MIN(id) AS id, COUNT(*) AS n
  FROM whatsapp_instances WHERE ativo = true GROUP BY company_id
) i ON i.company_id = c.company_id AND i.n = 1
WHERE c.tipo = 'grupo' AND c.whatsapp_instance_id IS NULL
GROUP BY c.company_id, i.id
ORDER BY c.company_id;

-- 1.2 — aplique:
UPDATE conversas c
SET whatsapp_instance_id = i.id
FROM (
  SELECT company_id, MIN(id) AS id, COUNT(*) AS n
  FROM whatsapp_instances WHERE ativo = true GROUP BY company_id
) i
WHERE i.n = 1
  AND c.company_id = i.company_id
  AND c.tipo = 'grupo'
  AND c.whatsapp_instance_id IS NULL;

-- 1.3 — o que sobrou (empresas multi-número; deixar como está é o certo):
SELECT company_id, COUNT(*) AS grupos_ainda_sem_instancia
FROM conversas WHERE tipo = 'grupo' AND whatsapp_instance_id IS NULL
GROUP BY company_id ORDER BY company_id;


-- -----------------------------------------------------------------------------
-- BLOCO 2 — reenfileirar as adições ao grupo que falharam pelo 9º dígito
-- -----------------------------------------------------------------------------
-- Por quê: todas as adições falharam com WHATSAPP_RECUSOU porque o endereço
-- enviado tinha o 9º dígito e o JID do contato não tem. O código novo resolve o
-- endereço real antes de adicionar, então vale reprocessar esses itens.
--
-- RODE SÓ DEPOIS DO DEPLOY. Antes do deploy eles falham de novo igual.
--
-- Atenção: isto faz o worker ADICIONAR gente de verdade aos grupos. Confira a
-- lista do 2.1 e tire o que não quiser mais adicionar.

-- 2.1 — confira ANTES (o que exatamente vai ser reprocessado):
SELECT i.id, i.company_id, i.participante_jid, i.erro_codigo,
       o.comunidade_nome, o.tipo, o.created_at
FROM comunidade_fila_itens i
JOIN comunidade_operacoes o ON o.id = i.operacao_id
WHERE i.status = 'falhou'
  AND i.erro_codigo = 'WHATSAPP_RECUSOU'
ORDER BY i.id;

-- 2.2 — devolve os itens para a fila (zera tentativa e erro):
UPDATE comunidade_fila_itens
SET status = 'pendente',
    resultado = NULL,
    erro_codigo = NULL,
    erro_mensagem = NULL,
    tentativas = 0,
    concluido_em = NULL,
    proxima_tentativa_em = NOW(),
    worker_id = NULL,
    lease_inicio = NULL,
    lease_ate = NULL,
    updated_at = NOW()
WHERE status = 'falhou'
  AND erro_codigo = 'WHATSAPP_RECUSOU';

-- 2.3 — reabre as operações para o worker pegar (ele ignora o que não está em execução):
UPDATE comunidade_operacoes o
SET status = 'em_execucao',
    falhados = 0,
    updated_at = NOW()
WHERE o.status = 'concluida_com_erros'
  AND EXISTS (
    SELECT 1 FROM comunidade_fila_itens i
    WHERE i.operacao_id = o.id AND i.status = 'pendente'
  );

-- 2.4 — acompanhe (deve ir de pendente → concluida; o ritmo é conservador):
SELECT o.comunidade_nome, o.status, o.total, o.concluidos, o.falhados,
       i.participante_jid, i.status AS item_status, i.erro_codigo, i.erro_mensagem
FROM comunidade_operacoes o
JOIN comunidade_fila_itens i ON i.operacao_id = o.id
ORDER BY o.updated_at DESC, i.id;
