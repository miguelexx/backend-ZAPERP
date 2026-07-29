-- Mensagem de finalização (config no chatbot_triage via ia_config JSONB)
-- Tabela de avaliações de atendimento (nota 0-10) — integrado UltraMSG

-- 1) Tabela avaliacoes_atendimento
CREATE TABLE IF NOT EXISTS public.avaliacoes_atendimento (
  id bigserial PRIMARY KEY,
  company_id bigint NOT NULL,
  atendimento_id integer NOT NULL,
  atendente_id integer NOT NULL,
  conversa_id integer NOT NULL,
  cliente_id integer,
  nota smallint NOT NULL CHECK (nota >= 0 AND nota <= 10),
  criado_em timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT avaliacoes_atendimento_company_fk FOREIGN KEY (company_id) REFERENCES public.empresas(id),
  CONSTRAINT avaliacoes_atendimento_atendimento_fk FOREIGN KEY (atendimento_id) REFERENCES public.atendimentos(id),
  CONSTRAINT avaliacoes_atendimento_atendente_fk FOREIGN KEY (atendente_id) REFERENCES public.usuarios(id),
  CONSTRAINT avaliacoes_atendimento_conversa_fk FOREIGN KEY (conversa_id) REFERENCES public.conversas(id),
  CONSTRAINT avaliacoes_atendimento_cliente_fk FOREIGN KEY (cliente_id) REFERENCES public.clientes(id),
  CONSTRAINT avaliacoes_atendimento_unique UNIQUE (atendimento_id)
);

COMMENT ON TABLE public.avaliacoes_atendimento IS 'Notas de avaliação (0-10) dos clientes após atendimento finalizado. Uma nota por atendimento. atendente_id = usuário que atendeu (encerrou).';
COMMENT ON COLUMN public.avaliacoes_atendimento.atendente_id IS 'Usuário que atendeu o cliente (quem encerrou a conversa).';

CREATE INDEX IF NOT EXISTS idx_avaliacoes_company_criado ON public.avaliacoes_atendimento (company_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_avaliacoes_atendente ON public.avaliacoes_atendimento (company_id, atendente_id);
