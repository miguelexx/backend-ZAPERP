-- =====================================================================
-- conversas.telefone — caber o ID de grupo LEGADO (`<dono>-<criação>`)
--
-- ⚠️  NÃO APLICADA. Quem roda é o Miguel, no SQL Editor do Supabase.
--
-- POR QUÊ: grupo criado antes de 2021 tem id `553484315821-1634262477@g.us`
-- → 23 caracteres sem o `@g.us`. A coluna `conversas.telefone` é
-- `character varying(20)`, então o INSERT morre com
--     22001: value too long for type character varying(20)
-- e o grupo NUNCA entra — nem pelo botão "Sincronizar todos os grupos"
-- (services/ultramsgGroupsSyncService.js), nem pelo webhook de inbound
-- (helpers/conversationSync.js → findOrCreateConversation), que é o que
-- faria a mensagem desse grupo chegar na tela.
--
-- O filtro de código que descartava esses ids já foi corrigido (10/11,
-- extractGroupFields aceita LEGACY_GROUP_ID_RE), por isso o erro agora
-- aparece no aviso âmbar da tela em vez de sumir em silêncio.
--
-- ID moderno (`120363…`) tem 18 dígitos e sempre coube — por isso só os
-- grupos antigos falham.
--
-- RISCO: baixo. ALTER … TYPE varchar(64) só aumenta o limite; o Postgres
-- reescreve a tabela e recria os índices de `telefone`
-- (idx_conversas_company_instance_telefone_unique,
--  idx_conversas_company_telefone_legacy_null_unique,
--  idx_conversas_company_whatsapp_instance_telefone e os *_open_unique).
-- Nenhuma view depende da coluna. Em tabela grande o ALTER pega
-- ACCESS EXCLUSIVE: rodar fora do horário de pico.
--
-- ORDEM: migration ANTES do deploy (anti-padrão 14). Depois de aplicar,
-- clicar de novo em "Sincronizar todos os grupos" para os grupos antigos
-- entrarem.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) CONFERÊNCIA ANTES — qual é o limite hoje?
--    Esperado: conversas.telefone = character varying, 20.
-- ---------------------------------------------------------------------
select table_name, column_name, data_type, character_maximum_length
from information_schema.columns
where table_schema = 'public'
  and table_name in ('conversas', 'clientes')
  and column_name = 'telefone'
order by table_name;

-- ---------------------------------------------------------------------
-- 2) O ALTER
--    varchar(20) → varchar(64) é coerção binária: o Postgres (≥ 9.2) NÃO
--    reescreve a tabela nem recria índices — só troca o catálogo. O lock
--    ACCESS EXCLUSIVE dura milissegundos; o lock_timeout evita ficar na
--    fila atrás de uma query longa (se estourar, é só rodar de novo).
-- ---------------------------------------------------------------------
set lock_timeout = '5s';

alter table public.conversas
  alter column telefone type character varying(64);

comment on column public.conversas.telefone is
  'Telefone canônico do contato OU id do grupo sem @g.us. Grupos antigos '
  '(pré-2021) usam `<telefone do dono>-<timestamp>` e passam de 20 chars — '
  'daí o varchar(64) (13/11/2026).';

-- ---------------------------------------------------------------------
-- 3) CONFERÊNCIA DEPOIS — deve voltar 64
-- ---------------------------------------------------------------------
select column_name, data_type, character_maximum_length
from information_schema.columns
where table_schema = 'public'
  and table_name = 'conversas'
  and column_name = 'telefone';

-- ---------------------------------------------------------------------
-- 4) DEPOIS DO RE-SYNC — conferir que os grupos antigos entraram
-- ---------------------------------------------------------------------
-- select id, company_id, whatsapp_instance_id, telefone, nome_grupo, criado_em
-- from public.conversas
-- where tipo = 'grupo'
--   and telefone ~ '^[0-9]{5,15}-[0-9]{10,15}$'
-- order by criado_em desc;
