create table if not exists public.empresa_pix_config (
  company_id bigint primary key references public.empresas(id) on delete cascade,
  tipo_chave text not null,
  chave_pix text not null,
  nome_recebedor text not null,
  mensagem_padrao text null,
  atualizado_por bigint null references public.usuarios(id) on delete set null,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

create index if not exists idx_empresa_pix_config_company_id
  on public.empresa_pix_config (company_id);
