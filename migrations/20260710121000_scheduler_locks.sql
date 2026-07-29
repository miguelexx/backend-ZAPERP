-- Lock distribuido simples para schedulers internos em ambientes com mais de uma instancia Node.

CREATE TABLE IF NOT EXISTS public.scheduler_locks (
  name text PRIMARY KEY,
  locked_until timestamp with time zone NOT NULL,
  locked_by text,
  updated_at timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scheduler_locks_locked_until
  ON public.scheduler_locks (locked_until);

COMMENT ON TABLE public.scheduler_locks IS
  'Locks efemeros para evitar execucao duplicada de schedulers em multiplas instancias do backend.';
