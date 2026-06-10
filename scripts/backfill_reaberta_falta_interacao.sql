-- Backfill: tag azul para conversas reabertas pelo alerta sem resposta (dados antigos).
-- Execute no SQL Editor do Supabase (role postgres), depois recarregue a lista de chats.
-- Regra: gestor notificado + conversa aberta sem atendente + evidência de reabertura automática.

-- 1) Marcar conversas com evento gestor_notificado e (conversa_reaberta OU histórico de reabertura)
WITH reabertas_alerta AS (
  SELECT
    c.id AS conversa_id,
    c.company_id,
    COALESCE(
      MAX(ev_reab.criado_em),
      MAX(ev_gestor.criado_em),
      MAX(h.criado_em::timestamptz)
    ) AS reaberta_em
  FROM public.conversas c
  INNER JOIN public.alerta_atendimento_sem_resposta_eventos ev_gestor
    ON ev_gestor.conversa_id = c.id
   AND ev_gestor.company_id = c.company_id
   AND ev_gestor.tipo = 'gestor_notificado'
  LEFT JOIN public.alerta_atendimento_sem_resposta_eventos ev_reab
    ON ev_reab.conversa_id = c.id
   AND ev_reab.company_id = c.company_id
   AND ev_reab.tipo = 'conversa_reaberta'
  LEFT JOIN public.historico_atendimentos h
    ON h.conversa_id = c.id
   AND h.acao = 'alerta_sem_resposta_reabertura'
  WHERE c.status_atendimento = 'aberta'
    AND c.atendente_id IS NULL
    AND (c.tipo IS NULL OR c.tipo <> 'grupo')
    AND (ev_reab.id IS NOT NULL OR h.id IS NOT NULL)
  GROUP BY c.id, c.company_id
)
UPDATE public.conversas c
SET reaberta_falta_interacao_em = r.reaberta_em
FROM reabertas_alerta r
WHERE c.id = r.conversa_id
  AND c.company_id = r.company_id
  AND c.reaberta_falta_interacao_em IS NULL;

-- 2) Retroativo sem evento conversa_reaberta: gestor notificado + fila aberta (reabertura implícita)
WITH reabertas_implicitas AS (
  SELECT
    c.id AS conversa_id,
    c.company_id,
    MAX(ev.criado_em) AS reaberta_em
  FROM public.conversas c
  INNER JOIN public.alerta_atendimento_sem_resposta_eventos ev
    ON ev.conversa_id = c.id
   AND ev.company_id = c.company_id
   AND ev.tipo = 'gestor_notificado'
  WHERE c.status_atendimento = 'aberta'
    AND c.atendente_id IS NULL
    AND (c.tipo IS NULL OR c.tipo <> 'grupo')
    AND c.reaberta_falta_interacao_em IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.alerta_atendimento_sem_resposta_eventos ev2
      WHERE ev2.conversa_id = c.id
        AND ev2.company_id = c.company_id
        AND ev2.tipo = 'conversa_reaberta'
    )
  GROUP BY c.id, c.company_id
)
UPDATE public.conversas c
SET reaberta_falta_interacao_em = r.reaberta_em
FROM reabertas_implicitas r
WHERE c.id = r.conversa_id
  AND c.company_id = r.company_id;

-- 3) Espelhar no estado do alerta (para consultas futuras)
INSERT INTO public.alerta_atendimento_sem_resposta_estado (
  company_id,
  conversa_id,
  gestor_notificado_em,
  reaberta_em,
  atualizado_em
)
SELECT
  c.company_id,
  c.id,
  c.reaberta_falta_interacao_em,
  c.reaberta_falta_interacao_em,
  NOW()
FROM public.conversas c
WHERE c.reaberta_falta_interacao_em IS NOT NULL
ON CONFLICT (company_id, conversa_id) DO UPDATE SET
  reaberta_em = EXCLUDED.reaberta_em,
  gestor_notificado_em = COALESCE(
    public.alerta_atendimento_sem_resposta_estado.gestor_notificado_em,
    EXCLUDED.gestor_notificado_em
  ),
  atualizado_em = NOW();

-- Conferência (opcional)
-- SELECT id, nome_contato_cache, status_atendimento, atendente_id, reaberta_falta_interacao_em
-- FROM public.conversas
-- WHERE reaberta_falta_interacao_em IS NOT NULL
-- ORDER BY reaberta_falta_interacao_em DESC
-- LIMIT 30;
