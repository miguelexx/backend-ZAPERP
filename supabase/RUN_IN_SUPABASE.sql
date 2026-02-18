-- ============================================================
-- Execute este script no Supabase: SQL Editor → New query → Run
-- IMPORTANTE: Cole e execute TUDO de uma vez (do início ao fim).
-- ============================================================

-- PRIMEIRO: remover constraint antiga que causa erro 23505 (duplicata em clientes)
ALTER TABLE public.clientes
  DROP CONSTRAINT IF EXISTS clientes_telefone_unique;

-- 1) Coluna ultima_atividade em conversas (obrigatória para webhook Z-API)
ALTER TABLE public.conversas
  ADD COLUMN IF NOT EXISTS ultima_atividade timestamp with time zone DEFAULT now();

COMMENT ON COLUMN public.conversas.ultima_atividade IS 'Última atividade na conversa (nova mensagem ou envio). Usado para ordenar a lista.';

-- 0b) Preferências da empresa (Z-API)
-- Auto-sincronizar contatos quando a instância conectar (Configurações → Clientes)
ALTER TABLE public.empresas
  ADD COLUMN IF NOT EXISTS zapi_auto_sync_contatos boolean DEFAULT true;

COMMENT ON COLUMN public.empresas.zapi_auto_sync_contatos IS 'Se true, ao conectar no Z-API dispara sync de contatos do celular.';

-- Preencher conversas existentes
UPDATE public.conversas c
SET ultima_atividade = COALESCE(
  (SELECT max(m.criado_em) FROM public.mensagens m WHERE m.conversa_id = c.id),
  c.criado_em
)
WHERE c.ultima_atividade IS NULL;

-- 2) Colunas de mídia em mensagens (imagem, áudio, vídeo, documento, sticker)
ALTER TABLE public.mensagens
  ADD COLUMN IF NOT EXISTS tipo varchar(20) DEFAULT 'texto',
  ADD COLUMN IF NOT EXISTS url text,
  ADD COLUMN IF NOT EXISTS nome_arquivo text;

-- 3) Grupos: remetente na mensagem
ALTER TABLE public.mensagens
  ADD COLUMN IF NOT EXISTS remetente_nome varchar(255),
  ADD COLUMN IF NOT EXISTS remetente_telefone varchar(50);

-- 3b) Responder mensagens (citação estilo WhatsApp) — metadata persistida no banco
-- Usado pelo frontend para exibir o "bloco de resposta" dentro da bolha.
ALTER TABLE public.mensagens
  ADD COLUMN IF NOT EXISTS reply_meta jsonb;

COMMENT ON COLUMN public.mensagens.reply_meta IS 'Metadados de resposta: { name, snippet, ts, replyToId }.';

-- 3c) Apagar "para mim" (ocultar por usuário, persistente)
-- Quando o usuário apaga "pra mim", a mensagem NÃO some do banco; ela fica oculta só para aquele usuário.
CREATE TABLE IF NOT EXISTS public.mensagens_ocultas (
  id bigserial PRIMARY KEY,
  company_id bigint NOT NULL,
  conversa_id bigint NOT NULL,
  mensagem_id bigint NOT NULL,
  usuario_id bigint NOT NULL,
  criado_em timestamp with time zone NOT NULL DEFAULT now()
);

-- Evita duplicar (mesma mensagem ocultada várias vezes)
CREATE UNIQUE INDEX IF NOT EXISTS idx_mensagens_ocultas_unique
  ON public.mensagens_ocultas (company_id, usuario_id, mensagem_id);

CREATE INDEX IF NOT EXISTS idx_mensagens_ocultas_conversa_usuario
  ON public.mensagens_ocultas (company_id, conversa_id, usuario_id);

-- 4) Conversas: tipo grupo, nome_grupo, foto_grupo
ALTER TABLE public.conversas
  ADD COLUMN IF NOT EXISTS tipo text DEFAULT 'cliente',
  ADD COLUMN IF NOT EXISTS nome_grupo text,
  ADD COLUMN IF NOT EXISTS foto_grupo text;

-- 5) Clientes: foto de perfil
ALTER TABLE public.clientes
  ADD COLUMN IF NOT EXISTS foto_perfil text;

-- 5b) Clientes: campos de CRM (contatos completos)
ALTER TABLE public.clientes
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS empresa text,
  ADD COLUMN IF NOT EXISTS ultimo_contato timestamp with time zone,
  ADD COLUMN IF NOT EXISTS atualizado_em timestamp with time zone DEFAULT now();

-- Email único por empresa (quando preenchido)
CREATE UNIQUE INDEX IF NOT EXISTS idx_clientes_company_email_unique
  ON public.clientes (company_id, lower(email))
  WHERE email IS NOT NULL AND trim(email) != '';

-- Ajuda ordenação/relatórios de CRM
CREATE INDEX IF NOT EXISTS idx_clientes_company_ultimo_contato
  ON public.clientes (company_id, ultimo_contato DESC NULLS LAST);

-- 5c) Tags por contato (associar tags a clientes)
CREATE TABLE IF NOT EXISTS public.cliente_tags (
  id bigserial PRIMARY KEY,
  company_id integer NOT NULL DEFAULT 1,
  cliente_id integer NOT NULL,
  tag_id integer NOT NULL,
  criado_em timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT cliente_tags_company_fk FOREIGN KEY (company_id) REFERENCES public.empresas(id),
  CONSTRAINT cliente_tags_cliente_fk FOREIGN KEY (cliente_id) REFERENCES public.clientes(id),
  CONSTRAINT cliente_tags_tag_fk FOREIGN KEY (tag_id) REFERENCES public.tags(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cliente_tags_unique
  ON public.cliente_tags (company_id, cliente_id, tag_id);

CREATE INDEX IF NOT EXISTS idx_cliente_tags_lookup
  ON public.cliente_tags (company_id, cliente_id);

-- 6) Mensagens: id do WhatsApp (evitar duplicata) e status
ALTER TABLE public.mensagens
  ADD COLUMN IF NOT EXISTS whatsapp_id character varying;

-- ============================================================
-- MULTI-TENANT HARDENING (padrão SaaS)
-- garante company_id preenchido e com default em tabelas principais
-- ============================================================

-- Preencher company_id nulo com 1 (compat) — antes de impor NOT NULL/UNIQUE
UPDATE public.clientes SET company_id = 1 WHERE company_id IS NULL;
UPDATE public.tags SET company_id = 1 WHERE company_id IS NULL;
UPDATE public.departamentos SET company_id = 1 WHERE company_id IS NULL;
UPDATE public.conversas SET company_id = 1 WHERE company_id IS NULL;
UPDATE public.mensagens SET company_id = 1 WHERE company_id IS NULL;
UPDATE public.conversa_tags SET company_id = 1 WHERE company_id IS NULL;
UPDATE public.usuarios SET company_id = 1 WHERE company_id IS NULL;
UPDATE public.atendimentos SET company_id = 1 WHERE company_id IS NULL;
-- se a tabela existir de versões anteriores
UPDATE public.cliente_tags SET company_id = 1 WHERE company_id IS NULL;

-- Deduplicar TAGS por empresa antes do unique (evita falha ao criar índice)
WITH d AS (
  SELECT id, company_id, nome,
         row_number() OVER (PARTITION BY company_id, lower(trim(nome)) ORDER BY id) AS rn
  FROM public.tags
  WHERE nome IS NOT NULL AND trim(nome) != ''
)
UPDATE public.tags t
SET nome = trim(t.nome) || ' #' || d.rn
FROM d
WHERE t.id = d.id AND d.rn > 1;

-- Tags: o unique global em `nome` quebra multi-tenant. Troca para unique por empresa.
ALTER TABLE public.tags
  DROP CONSTRAINT IF EXISTS tags_nome_key;
ALTER TABLE public.tags
  DROP CONSTRAINT IF EXISTS tags_nome_unique;
DROP INDEX IF EXISTS public.tags_nome_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_company_nome_unique
  ON public.tags (company_id, lower(nome));

-- Deduplicar DEPARTAMENTOS por empresa antes do unique (evita falha ao criar índice)
WITH d AS (
  SELECT id, company_id, nome,
         row_number() OVER (PARTITION BY company_id, lower(trim(nome)) ORDER BY id) AS rn
  FROM public.departamentos
  WHERE nome IS NOT NULL AND trim(nome) != ''
)
UPDATE public.departamentos dep
SET nome = trim(dep.nome) || ' #' || d.rn
FROM d
WHERE dep.id = d.id AND d.rn > 1;

-- Departamentos: opcionalmente único por empresa
CREATE UNIQUE INDEX IF NOT EXISTS idx_departamentos_company_nome_unique
  ON public.departamentos (company_id, lower(nome));

-- DEFAULT + NOT NULL para company_id (tabelas principais)
ALTER TABLE public.clientes ALTER COLUMN company_id SET DEFAULT 1;
ALTER TABLE public.tags ALTER COLUMN company_id SET DEFAULT 1;
ALTER TABLE public.departamentos ALTER COLUMN company_id SET DEFAULT 1;
ALTER TABLE public.conversas ALTER COLUMN company_id SET DEFAULT 1;
ALTER TABLE public.mensagens ALTER COLUMN company_id SET DEFAULT 1;
ALTER TABLE public.conversa_tags ALTER COLUMN company_id SET DEFAULT 1;
ALTER TABLE public.usuarios ALTER COLUMN company_id SET DEFAULT 1;
ALTER TABLE public.atendimentos ALTER COLUMN company_id SET DEFAULT 1;
ALTER TABLE public.cliente_tags ALTER COLUMN company_id SET DEFAULT 1;

ALTER TABLE public.clientes ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE public.tags ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE public.departamentos ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE public.conversas ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE public.mensagens ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE public.conversa_tags ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE public.usuarios ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE public.atendimentos ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE public.cliente_tags ALTER COLUMN company_id SET NOT NULL;

-- (removido: bloco duplicado de DEFAULT/NOT NULL)

-- Índice único para não duplicar mensagens pelo mesmo whatsapp_id
CREATE UNIQUE INDEX IF NOT EXISTS idx_mensagens_conversa_whatsapp_id
  ON public.mensagens (conversa_id, whatsapp_id)
  WHERE whatsapp_id IS NOT NULL AND whatsapp_id != '';

-- ============================================================
-- SEM DUPLICATAS: clientes e conversas (um número = um cliente)
-- Usa coluna temporária para não violar clientes_telefone_unique durante o processo.
-- ============================================================

-- Garantir que todos os clientes tenham company_id (quem está NULL vira 1)
UPDATE public.clientes SET company_id = 1 WHERE company_id IS NULL;

-- Coluna temporária: normalizar aqui primeiro (não mexe em telefone, evita 23505)
ALTER TABLE public.clientes ADD COLUMN IF NOT EXISTS telefone_norm text;

UPDATE public.clientes c
SET telefone_norm = (
  CASE
    WHEN trim(regexp_replace(c.telefone, '\D', '', 'g')) = '' THEN c.telefone
    WHEN length(regexp_replace(c.telefone, '\D', '', 'g')) IN (10, 11)
      THEN '55' || regexp_replace(c.telefone, '\D', '', 'g')
    WHEN regexp_replace(c.telefone, '\D', '', 'g') ~ '^55'
      THEN left(regexp_replace(c.telefone, '\D', '', 'g'), 13)
    ELSE left(regexp_replace(c.telefone, '\D', '', 'g'), 13)
  END
)
WHERE c.telefone IS NOT NULL AND c.telefone != '';

-- Apontar conversas para o cliente canônico (menor id por company_id + telefone_norm)
UPDATE public.conversas conv
SET cliente_id = (
  SELECT min(cl.id) FROM public.clientes cl
  WHERE cl.company_id = (SELECT company_id FROM public.clientes WHERE id = conv.cliente_id)
    AND cl.telefone_norm = (SELECT telefone_norm FROM public.clientes WHERE id = conv.cliente_id)
)
WHERE conv.cliente_id IS NOT NULL
  AND conv.cliente_id != (
    SELECT min(cl.id) FROM public.clientes cl
    WHERE cl.company_id = (SELECT company_id FROM public.clientes WHERE id = conv.cliente_id)
      AND cl.telefone_norm = (SELECT telefone_norm FROM public.clientes WHERE id = conv.cliente_id)
  );

-- Remover clientes duplicados (mantém o de menor id por company_id + telefone_norm)
DELETE FROM public.clientes a
USING public.clientes b
WHERE a.company_id = b.company_id AND a.telefone_norm = b.telefone_norm AND a.id > b.id;

-- Agora sim: remover constraint antiga e copiar telefone_norm para telefone
ALTER TABLE public.clientes
  DROP CONSTRAINT IF EXISTS clientes_telefone_unique;

UPDATE public.clientes
SET telefone = telefone_norm
WHERE telefone_norm IS NOT NULL AND telefone_norm != '';

ALTER TABLE public.clientes DROP COLUMN IF EXISTS telefone_norm;

-- Constraint única: um cliente por (empresa, telefone)
ALTER TABLE public.clientes
  DROP CONSTRAINT IF EXISTS clientes_company_telefone_unique;
ALTER TABLE public.clientes
  ADD CONSTRAINT clientes_company_telefone_unique UNIQUE (company_id, telefone);

-- Normalizar telefone em conversas (contato individual) para consistência
UPDATE public.conversas conv
SET telefone = (
  CASE
    WHEN conv.telefone LIKE '%@g.us' THEN conv.telefone
    WHEN trim(regexp_replace(conv.telefone, '\D', '', 'g')) = '' THEN conv.telefone
    WHEN length(regexp_replace(conv.telefone, '\D', '', 'g')) IN (10, 11)
      THEN '55' || regexp_replace(conv.telefone, '\D', '', 'g')
    WHEN regexp_replace(conv.telefone, '\D', '', 'g') ~ '^55'
      THEN left(regexp_replace(conv.telefone, '\D', '', 'g'), 13)
    ELSE left(regexp_replace(conv.telefone, '\D', '', 'g'), 13)
  END
)
WHERE conv.telefone IS NOT NULL AND conv.telefone != '' AND conv.telefone NOT LIKE '%@g.us';

-- Uma única conversa aberta/em atendimento por (empresa, telefone) para contato individual
-- (Se deu erro 23505 clientes_telefone_unique acima, execute FIX_CLIENTES_DUPLICATA.sql e depois este script todo de novo desde a linha 1.)
DROP INDEX IF EXISTS idx_conversas_company_telefone_open_unique;
CREATE UNIQUE INDEX idx_conversas_company_telefone_open_unique
  ON public.conversas (company_id, telefone)
  WHERE (tipo IS NULL OR tipo = 'cliente') AND status_atendimento IN ('aberta', 'em_atendimento');

-- Confirme no Supabase que não há erros. Depois reinicie o backend se estiver rodando.
