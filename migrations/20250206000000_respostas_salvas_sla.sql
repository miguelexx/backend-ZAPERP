-- Respostas salvas por setor (Financeiro, Suporte, Comercial = departamentos)
CREATE TABLE IF NOT EXISTS public.respostas_salvas (
  id serial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES public.empresas(id),
  departamento_id integer REFERENCES public.departamentos(id),
  titulo varchar(255) NOT NULL,
  texto text NOT NULL,
  criado_em timestamptz DEFAULT now(),
  CONSTRAINT respostas_salvas_company_fk FOREIGN KEY (company_id) REFERENCES public.empresas(id),
  CONSTRAINT respostas_salvas_departamento_fk FOREIGN KEY (departamento_id) REFERENCES public.departamentos(id)
);

-- SLA: minutos sem resposta para alerta (por empresa)
ALTER TABLE public.empresas ADD COLUMN IF NOT EXISTS sla_minutos_sem_resposta integer DEFAULT 30;
COMMENT ON COLUMN public.empresas.sla_minutos_sem_resposta IS 'Alerta quando cliente ficar mais de X min sem resposta';
