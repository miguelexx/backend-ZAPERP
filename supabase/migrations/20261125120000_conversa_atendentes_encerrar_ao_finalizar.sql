-- Co-atendimento acaba junto com o atendimento.
--
-- Problema: `conversa_atendentes.ativo` ficava TRUE para sempre. O cliente voltava dias
-- depois, outra pessoa assumia e os co-atendentes antigos reapareciam na Minha fila deles
-- (e no modal do novo responsável, ocupando o limite de 3 co-atendentes). E quem recebia a
-- conversa por transferência sendo co-atendente aparecia duas vezes (Responsável + Co-atendente).
--
-- O backend já trata encerrar, reabrir, assumir da fila, transferir e devolver ao setor
-- (encerrarCoAtendimentoDaConversa). Este gatilho cobre os OUTROS caminhos que mexem direto
-- no banco (finalização por ausência, jobs, bot/triagem, alerta sem resposta, disparo):
--   1. conversa passou a finalizada            -> desativa todos os co-atendentes
--   2. conversa voltou para a fila (sem dono)  -> desativa todos os co-atendentes
--   3. novo responsável era co-atendente       -> desativa só a participação dele
--
-- Seguro:
--   * só mexe em linhas ativas; o gatilho de guarda (conversa_atendentes_guard) ignora UPDATE
--     para ativo=false, então não trava `conversas` nem entra em recursão;
--   * qualquer erro aqui vira WARNING — nunca impede encerrar/transferir uma conversa.
-- Rodar no Supabase SQL Editor (o código novo funciona com ou sem ele).

BEGIN;

-- Colunas de auditoria (migration 20260807130000). IF NOT EXISTS: não faz nada se já existem.
ALTER TABLE public.conversa_atendentes
  ADD COLUMN IF NOT EXISTS removido_em timestamp with time zone,
  ADD COLUMN IF NOT EXISTS removido_por integer REFERENCES public.usuarios(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION public.encerrar_co_atendimento_ao_finalizar()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  fechada_agora boolean;
  voltou_para_fila boolean;
BEGIN
  fechada_agora :=
    lower(trim(coalesce(NEW.status_atendimento, ''))) IN ('fechada', 'encerrada', 'finalizada', 'finalizado')
    AND lower(trim(coalesce(OLD.status_atendimento, ''))) NOT IN ('fechada', 'encerrada', 'finalizada', 'finalizado');
  voltou_para_fila := OLD.atendente_id IS NOT NULL AND NEW.atendente_id IS NULL;

  BEGIN
    IF fechada_agora OR voltou_para_fila THEN
      UPDATE public.conversa_atendentes
         SET ativo = false,
             removido_em = coalesce(removido_em, now())
       WHERE company_id = NEW.company_id
         AND conversa_id = NEW.id
         AND ativo = true;
    ELSIF NEW.atendente_id IS NOT NULL AND NEW.atendente_id IS DISTINCT FROM OLD.atendente_id THEN
      UPDATE public.conversa_atendentes
         SET ativo = false,
             removido_em = coalesce(removido_em, now())
       WHERE company_id = NEW.company_id
         AND conversa_id = NEW.id
         AND usuario_id = NEW.atendente_id
         AND ativo = true;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'encerrar_co_atendimento_ao_finalizar (conversa %): %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS conversa_atendentes_encerrar_ao_finalizar ON public.conversas;
CREATE TRIGGER conversa_atendentes_encerrar_ao_finalizar
AFTER UPDATE OF status_atendimento, atendente_id ON public.conversas
FOR EACH ROW
WHEN (
  OLD.status_atendimento IS DISTINCT FROM NEW.status_atendimento
  OR OLD.atendente_id IS DISTINCT FROM NEW.atendente_id
)
EXECUTE FUNCTION public.encerrar_co_atendimento_ao_finalizar();

-- Limpeza do resíduo que já existe hoje:
--   * co-atendentes de conversas finalizadas ou sem responsável;
--   * o responsável principal listado também como co-atendente.
UPDATE public.conversa_atendentes ca
   SET ativo = false,
       removido_em = coalesce(ca.removido_em, now())
  FROM public.conversas c
 WHERE c.id = ca.conversa_id
   AND c.company_id = ca.company_id
   AND ca.ativo = true
   AND (
     lower(trim(coalesce(c.status_atendimento, ''))) IN ('fechada', 'encerrada', 'finalizada', 'finalizado')
     OR c.atendente_id IS NULL
     OR c.atendente_id = ca.usuario_id
   );

COMMIT;
