-- ============================================================================
-- DIAGNÓSTICO: "transferi a conversa e o histórico não apareceu para o outro
-- atendente"
--
-- Rodar no SQL Editor do Supabase (somente leitura — nenhum UPDATE/DELETE).
-- Objetivo: separar as 3 causas possíveis, porque o código do backend NÃO
-- recorta histórico por atendente (auditado em 2026-11-09):
--
--   (1) DONO MUDOU DEPOIS  → a conversa não está mais no nome de quem recebeu
--                            (outra pessoa assumiu / foi transferida de novo).
--                            Quem não é o dono vê o card "Este atendimento foi
--                            assumido por X — o histórico fica oculto".
--   (2) HISTÓRICO RACHADO  → existe OUTRA linha de conversa para o mesmo
--                            telefone (split por whatsapp_instance_id / ±9º
--                            dígito). O destinatário abriu o card vazio e a
--                            história está na conversa irmã.
--   (3) NADA ANTES         → a conversa realmente não tinha mensagens antes da
--                            transferência (nada para mostrar; não é bug).
--
-- Se NENHUMA das três marcar na linha reclamada, então sobra o tamanho da
-- primeira página no celular (16 bolhas; o resto vem no "Carregar mensagens
-- salvas" / rolar até o topo) — aí o ajuste é no frontend.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- QUERY 1 — as transferências dos últimos 30 dias, já classificadas
-- ----------------------------------------------------------------------------
with transferencias as (
  select
    a.id              as atendimento_id,
    a.company_id,
    a.conversa_id,
    a.de_usuario_id,
    a.para_usuario_id,
    a.criado_em       as transferido_em
  from atendimentos a
  where a.acao = 'transferiu'
    and a.criado_em >= now() - interval '30 days'
),
contagens as (
  select
    t.*,
    c.telefone,
    c.whatsapp_instance_id,
    c.atendente_id    as atendente_atual_id,
    c.status_atendimento,
    (select count(*) from mensagens m
       where m.company_id = t.company_id
         and m.conversa_id = t.conversa_id
         and m.criado_em < t.transferido_em)            as msgs_antes,
    (select count(*) from mensagens m
       where m.company_id = t.company_id
         and m.conversa_id = t.conversa_id)             as msgs_total,
    -- conversa irmã: mesmo telefone (ou variação ±9º dígito, pelos 8 últimos
    -- dígitos) em OUTRA linha de conversa da mesma empresa
    (select count(*) from conversas c2
       where c2.company_id = c.company_id
         and c2.id <> c.id
         and coalesce(c2.tipo, '') <> 'grupo'
         and right(regexp_replace(coalesce(c2.telefone, ''), '\D', '', 'g'), 8)
             = right(regexp_replace(coalesce(c.telefone, ''), '\D', '', 'g'), 8)
         and right(regexp_replace(coalesce(c.telefone, ''), '\D', '', 'g'), 8) <> ''
    )                                                   as irmas,
    (select max((select count(*) from mensagens m2
                   where m2.company_id = c2.company_id
                     and m2.conversa_id = c2.id))
       from conversas c2
       where c2.company_id = c.company_id
         and c2.id <> c.id
         and coalesce(c2.tipo, '') <> 'grupo'
         and right(regexp_replace(coalesce(c2.telefone, ''), '\D', '', 'g'), 8)
             = right(regexp_replace(coalesce(c.telefone, ''), '\D', '', 'g'), 8)
         and right(regexp_replace(coalesce(c.telefone, ''), '\D', '', 'g'), 8) <> ''
    )                                                   as msgs_na_irma
  from transferencias t
  join conversas c
    on c.id = t.conversa_id
   and c.company_id = t.company_id
)
select
  company_id,
  conversa_id,
  telefone,
  whatsapp_instance_id,
  de_usuario_id        as transferiu,
  para_usuario_id      as recebeu,
  atendente_atual_id,
  status_atendimento,
  transferido_em,
  msgs_antes,
  msgs_total,
  irmas,
  coalesce(msgs_na_irma, 0) as msgs_na_irma,
  case
    when msgs_antes = 0                                        then '3-NADA-ANTES'
    when atendente_atual_id is distinct from para_usuario_id   then '1-DONO-MUDOU'
    when irmas > 0 and coalesce(msgs_na_irma, 0) > msgs_total  then '2-HISTORICO-RACHADO'
    when irmas > 0                                             then '2?-TEM-CONVERSA-IRMA'
    else 'OK-HISTORICO-ESTAVA-LA'
  end as diagnostico
from contagens
order by transferido_em desc;

-- ----------------------------------------------------------------------------
-- QUERY 2 — trava por número (visibilidade por número WhatsApp)
-- Se a tabela existir e tiver linhas, uma transferência pode cair em quem NÃO
-- pode ver aquele número: aí o detalhe devolve 403 e o card desaparece da
-- lista dele. Se der erro "relation does not exist", a trava não está no banco
-- e esta causa está descartada.
-- ----------------------------------------------------------------------------
select
  a.company_id,
  a.conversa_id,
  a.para_usuario_id        as recebeu,
  c.whatsapp_instance_id   as numero_da_conversa,
  exists (
    select 1 from usuario_whatsapp_instances u
     where u.company_id = a.company_id
       and u.usuario_id = a.para_usuario_id
  )                        as destinatario_tem_trava,
  exists (
    select 1 from usuario_whatsapp_instances u
     where u.company_id = a.company_id
       and u.usuario_id = a.para_usuario_id
       and u.whatsapp_instance_id = c.whatsapp_instance_id
  )                        as destinatario_pode_ver_o_numero
from atendimentos a
join conversas c
  on c.id = a.conversa_id
 and c.company_id = a.company_id
where a.acao = 'transferiu'
  and a.criado_em >= now() - interval '30 days'
order by a.criado_em desc;

-- ----------------------------------------------------------------------------
-- QUERY 3 — "apagar só para mim" do destinatário (causa rara, mas existe):
-- mensagens antigas que ESSE atendente escondeu dele mesmo em algum momento.
-- Se vier > 0 para a conversa reclamada, o histórico está oculto só para ele.
-- ----------------------------------------------------------------------------
select
  o.company_id,
  o.conversa_id,
  o.usuario_id,
  count(*) as mensagens_ocultas_desse_usuario
from mensagens_ocultas o
where exists (
  select 1 from atendimentos a
   where a.company_id = o.company_id
     and a.conversa_id = o.conversa_id
     and a.acao = 'transferiu'
     and a.para_usuario_id = o.usuario_id
     and a.criado_em >= now() - interval '30 days'
)
group by o.company_id, o.conversa_id, o.usuario_id
order by mensagens_ocultas_desse_usuario desc;
