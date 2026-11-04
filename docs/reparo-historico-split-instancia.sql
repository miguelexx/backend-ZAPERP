-- ============================================================================
-- Reparo do "histórico some ao reabrir no dia seguinte" (split por whatsapp_instance_id)
-- Rode no SQL Editor do Supabase, NA ORDEM. Nada aqui apaga mensagens: o passo 3 só MOVE
-- mensagens do duplicado para a conversa que fica e remove a conversa vazia/legada.
-- Cada bloco é independente; o passo 3 está dentro de transação (BEGIN/COMMIT) para você revisar.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1) CLASSIFICADOR DE TOPOLOGIA — rode primeiro.
--    Mostra o NÚMERO de cada instância. Serve para saber se, nos pares das empresas
--    1 e 25, as duas instâncias são o MESMO número (= bug, pode mesclar) ou NÚMEROS
--    DIFERENTES (= o cliente escreveu p/ dois números da empresa; as 2 conversas estão
--    CORRETAS pela isolação por número — NÃO mesclar).
--    Se der erro de coluna, troque a lista por: select * from whatsapp_instances ...
-- ----------------------------------------------------------------------------
select *
from whatsapp_instances
where company_id in (1, 25, 33)
order by company_id, id;


-- ----------------------------------------------------------------------------
-- 2) DRY-RUN — revisão dos pares duplicados por telefone (não altera nada).
--    Para cada telefone com 2 conversas, mostra quem fica (keeper) e quem seria mesclado
--    (dup), com a instância e a contagem de mensagens de cada lado.
--    keeper = conversa com instância (não-null); dup = conversa legada (instância NULL).
--    Este dry-run cobre o caso CLARO (NULL × instância, ex.: empresa 33). Os pares entre
--    duas instâncias não-null (empresa 25: 25×26; empresa 1: 1×8/1×30) NÃO aparecem aqui —
--    dependem do passo 1 para decidir, e usam o template do passo 4.
-- ----------------------------------------------------------------------------
select
  g.company_id,
  g.telefone,
  max(case when c.whatsapp_instance_id is not null then c.id end)  as keeper_id,
  max(case when c.whatsapp_instance_id is not null then c.whatsapp_instance_id end) as keeper_instancia,
  (select count(*) from mensagens m
     where m.conversa_id = max(case when c.whatsapp_instance_id is not null then c.id end)
       and m.company_id = g.company_id)                            as keeper_msgs,
  max(case when c.whatsapp_instance_id is null then c.id end)      as dup_id_null,
  (select count(*) from mensagens m
     where m.conversa_id = max(case when c.whatsapp_instance_id is null then c.id end)
       and m.company_id = g.company_id)                            as dup_msgs
from conversas c
join (
  select company_id, telefone
  from conversas
  where coalesce(tipo,'') <> 'grupo' and telefone is not null
    and telefone not like 'lid:%' and telefone not like '%@g.us'
  group by company_id, telefone
  having count(*) = 2
     and count(*) filter (where whatsapp_instance_id is null) = 1
     and count(*) filter (where whatsapp_instance_id is not null) = 1
) g on g.company_id = c.company_id and g.telefone = c.telefone
group by g.company_id, g.telefone
order by g.company_id, g.telefone;


-- ----------------------------------------------------------------------------
-- 3) REPARO DO CASO CLARO (NULL × instância) — move histórico do dup (NULL) para o
--    keeper (instância) e remove a conversa NULL. Seguro: NULL nunca foi um número real.
--    REVISE o passo 2 antes. Rode o bloco inteiro; confira o count; só então troque
--    "rollback;" por "commit;" (ou rode de novo com commit).
-- ----------------------------------------------------------------------------
begin;

create temporary table _pares_null on commit drop as
select
  g.company_id,
  g.telefone,
  max(case when c.whatsapp_instance_id is not null then c.id end) as keeper_id,
  max(case when c.whatsapp_instance_id is null     then c.id end) as dup_id
from conversas c
join (
  select company_id, telefone
  from conversas
  where coalesce(tipo,'') <> 'grupo' and telefone is not null
    and telefone not like 'lid:%' and telefone not like '%@g.us'
  group by company_id, telefone
  having count(*) = 2
     and count(*) filter (where whatsapp_instance_id is null) = 1
     and count(*) filter (where whatsapp_instance_id is not null) = 1
) g on g.company_id = c.company_id and g.telefone = c.telefone
group by g.company_id, g.telefone;

-- Move histórico e dependências do dup (NULL) para o keeper (instância).
update mensagens m set conversa_id = p.keeper_id
  from _pares_null p where m.conversa_id = p.dup_id and m.company_id = p.company_id;
update atendimentos a set conversa_id = p.keeper_id
  from _pares_null p where a.conversa_id = p.dup_id and a.company_id = p.company_id;
update historico_atendimentos h set conversa_id = p.keeper_id
  from _pares_null p where h.conversa_id = p.dup_id;

-- Dependências com UNIQUE (poderiam colidir): descarta as do dup (conversa vazia/legada) antes.
delete from conversa_unreads  u using _pares_null p where u.conversa_id = p.dup_id and u.company_id = p.company_id;
delete from conversa_tags     t using _pares_null p where t.conversa_id = p.dup_id and t.company_id = p.company_id;
delete from mensagens_ocultas o using _pares_null p where o.conversa_id = p.dup_id and o.company_id = p.company_id;

-- Remove a conversa duplicada (NULL), já sem histórico.
delete from conversas c using _pares_null p where c.id = p.dup_id and c.company_id = p.company_id;

select count(*) as pares_mesclados from _pares_null;

rollback;   -- CONFIRA o count acima. Troque por commit; para efetivar.


-- ----------------------------------------------------------------------------
-- 4) TEMPLATE — reparo de reconexão (duas instâncias não-null do MESMO número, ex.: empresa 25
--    se 25 e 26 forem o mesmo número; empresa 1 se 1/8/30 forem o mesmo número).
--    SÓ use depois do passo 1 confirmar que as instâncias são o MESMO número. Se forem
--    números DIFERENTES, NÃO rode: as duas conversas estão corretas (isolação por número).
--    Defina KEEPER_INSTANCIA = a instância ATIVA hoje (p/ onde o inbound novo cai) e
--    DUP_INSTANCIA = a antiga. Move o histórico da antiga p/ a ativa, por telefone.
-- ----------------------------------------------------------------------------
-- begin;
-- create temporary table _pares_recon on commit drop as
-- select
--   g.company_id, g.telefone,
--   max(case when c.whatsapp_instance_id = :KEEPER_INSTANCIA then c.id end) as keeper_id,
--   max(case when c.whatsapp_instance_id = :DUP_INSTANCIA    then c.id end) as dup_id
-- from conversas c
-- join (
--   select company_id, telefone from conversas
--   where company_id = :COMPANY_ID
--     and whatsapp_instance_id in (:KEEPER_INSTANCIA, :DUP_INSTANCIA)
--     and coalesce(tipo,'') <> 'grupo'
--   group by company_id, telefone
--   having count(distinct whatsapp_instance_id) = 2
-- ) g on g.company_id = c.company_id and g.telefone = c.telefone
-- group by g.company_id, g.telefone;
-- update mensagens m set conversa_id = p.keeper_id from _pares_recon p where m.conversa_id = p.dup_id and m.company_id = p.company_id;
-- update atendimentos a set conversa_id = p.keeper_id from _pares_recon p where a.conversa_id = p.dup_id and a.company_id = p.company_id;
-- update historico_atendimentos h set conversa_id = p.keeper_id from _pares_recon p where h.conversa_id = p.dup_id;
-- delete from conversa_unreads  u using _pares_recon p where u.conversa_id = p.dup_id and u.company_id = p.company_id;
-- delete from conversa_tags     t using _pares_recon p where t.conversa_id = p.dup_id and t.company_id = p.company_id;
-- delete from mensagens_ocultas o using _pares_recon p where o.conversa_id = p.dup_id and o.company_id = p.company_id;
-- delete from conversas c using _pares_recon p where c.id = p.dup_id and c.company_id = p.company_id;
-- select count(*) as pares_mesclados from _pares_recon;
-- rollback;  -- troque por commit; para efetivar


-- ----------------------------------------------------------------------------
-- 5) OPCIONAL — marcar um is_default por empresa elimina a causa também sem o code fix.
--    Rode o passo 1 para ver qual instância deve ser a default de cada empresa e marque:
--    update whatsapp_instances set is_default = true where id = :ID_DA_INSTANCIA_PRINCIPAL;
-- ----------------------------------------------------------------------------
