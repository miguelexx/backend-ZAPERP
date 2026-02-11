-- WARNING: This schema is for context only and is not meant to be run.
-- Table order and constraints may not be valid for execution.

CREATE TABLE public.atendimentos (
  id integer NOT NULL DEFAULT nextval('atendimentos_id_seq'::regclass),
  conversa_id integer NOT NULL,
  de_usuario_id integer,
  para_usuario_id integer,
  acao text NOT NULL CHECK (acao = ANY (ARRAY['assumiu'::text, 'transferiu'::text, 'encerrou'::text, 'reabriu'::text])),
  observacao text,
  criado_em timestamp with time zone NOT NULL DEFAULT now(),
  company_id integer,
  CONSTRAINT atendimentos_pkey PRIMARY KEY (id),
  CONSTRAINT atendimentos_conversa_id_fkey FOREIGN KEY (conversa_id) REFERENCES public.conversas(id),
  CONSTRAINT atendimentos_de_usuario_id_fkey FOREIGN KEY (de_usuario_id) REFERENCES public.usuarios(id),
  CONSTRAINT atendimentos_para_usuario_id_fkey FOREIGN KEY (para_usuario_id) REFERENCES public.usuarios(id),
  CONSTRAINT atendimentos_company_fk FOREIGN KEY (company_id) REFERENCES public.empresas(id)
);
CREATE TABLE public.clientes (
  id integer NOT NULL DEFAULT nextval('clientes_id_seq'::regclass),
  telefone character varying NOT NULL,
  nome character varying,
  observacoes text,
  criado_em timestamp without time zone DEFAULT now(),
  wa_id text,
  company_id integer NOT NULL DEFAULT 1,
  CONSTRAINT clientes_pkey PRIMARY KEY (id)
);
CREATE TABLE public.comunidades (
  id integer NOT NULL DEFAULT nextval('comunidades_id_seq'::regclass),
  nome text NOT NULL,
  criado_em timestamp without time zone DEFAULT now(),
  company_id integer,
  CONSTRAINT comunidades_pkey PRIMARY KEY (id),
  CONSTRAINT comunidades_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.empresas(id)
);
CREATE TABLE public.conversa_tags (
  id integer NOT NULL DEFAULT nextval('conversa_tags_id_seq'::regclass),
  conversa_id integer,
  tag_id integer,
  company_id integer,
  criado_em timestamp without time zone DEFAULT now(),
  CONSTRAINT conversa_tags_pkey PRIMARY KEY (id),
  CONSTRAINT conversa_tags_conversa_id_fkey FOREIGN KEY (conversa_id) REFERENCES public.conversas(id),
  CONSTRAINT conversa_tags_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.tags(id),
  CONSTRAINT conversa_tags_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.empresas(id)
);
CREATE TABLE public.conversa_unreads (
  id bigint NOT NULL DEFAULT nextval('conversa_unreads_id_seq'::regclass),
  company_id bigint NOT NULL,
  conversa_id bigint NOT NULL,
  usuario_id bigint NOT NULL,
  unread_count integer DEFAULT 0,
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT conversa_unreads_pkey PRIMARY KEY (id)
);
CREATE TABLE public.conversas (
  id integer NOT NULL DEFAULT nextval('conversas_id_seq'::regclass),
  telefone character varying NOT NULL,
  criado_em timestamp without time zone DEFAULT now(),
  lida boolean DEFAULT false,
  cliente_id integer,
  usuario_id integer,
  atendente_id integer,
  status_atendimento text NOT NULL DEFAULT 'aberta'::text CHECK (status_atendimento = ANY (ARRAY['aberta'::text, 'em_atendimento'::text, 'fechada'::text])),
  atendente_atribuido_em timestamp with time zone,
  company_id integer,
  departamento_id integer,
  tipo text DEFAULT 'cliente'::text,
  nome_grupo text,
  CONSTRAINT conversas_pkey PRIMARY KEY (id),
  CONSTRAINT fk_conversa_cliente FOREIGN KEY (cliente_id) REFERENCES public.clientes(id),
  CONSTRAINT fk_usuario FOREIGN KEY (usuario_id) REFERENCES public.usuarios(id),
  CONSTRAINT conversas_departamento_id_fkey FOREIGN KEY (departamento_id) REFERENCES public.departamentos(id),
  CONSTRAINT conversas_atendente_id_fkey FOREIGN KEY (atendente_id) REFERENCES public.usuarios(id),
  CONSTRAINT conversas_cliente_fk FOREIGN KEY (cliente_id) REFERENCES public.clientes(id),
  CONSTRAINT conversas_usuario_fk FOREIGN KEY (usuario_id) REFERENCES public.usuarios(id),
  CONSTRAINT conversas_atendente_fk FOREIGN KEY (atendente_id) REFERENCES public.usuarios(id),
  CONSTRAINT conversas_company_fk FOREIGN KEY (company_id) REFERENCES public.empresas(id)
);
CREATE TABLE public.departamentos (
  id integer NOT NULL DEFAULT nextval('departamentos_id_seq'::regclass),
  nome text NOT NULL,
  company_id integer,
  criado_em timestamp without time zone DEFAULT now(),
  CONSTRAINT departamentos_pkey PRIMARY KEY (id),
  CONSTRAINT departamentos_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.empresas(id)
);
CREATE TABLE public.empresas (
  id integer NOT NULL DEFAULT nextval('empresas_id_seq'::regclass),
  nome character varying NOT NULL,
  ativo boolean DEFAULT true,
  criado_em timestamp without time zone DEFAULT now(),
  plano_id bigint,
  inicio_ciclo timestamp without time zone DEFAULT date_trunc('month'::text, now()),
  CONSTRAINT empresas_pkey PRIMARY KEY (id),
  CONSTRAINT empresas_plano_id_fkey FOREIGN KEY (plano_id) REFERENCES public.planos(id)
);
CREATE TABLE public.grupos (
  id integer NOT NULL DEFAULT nextval('grupos_id_seq'::regclass),
  nome text NOT NULL,
  criado_em timestamp without time zone DEFAULT now(),
  company_id integer,
  CONSTRAINT grupos_pkey PRIMARY KEY (id),
  CONSTRAINT grupos_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.empresas(id)
);
CREATE TABLE public.historico_atendimentos (
  id integer NOT NULL DEFAULT nextval('historico_atendimentos_id_seq'::regclass),
  conversa_id integer,
  usuario_id integer,
  acao character varying,
  criado_em timestamp without time zone DEFAULT now(),
  CONSTRAINT historico_atendimentos_pkey PRIMARY KEY (id),
  CONSTRAINT historico_conversa_fk FOREIGN KEY (conversa_id) REFERENCES public.conversas(id),
  CONSTRAINT historico_usuario_fk FOREIGN KEY (usuario_id) REFERENCES public.usuarios(id)
);
CREATE TABLE public.mensagens (
  id integer NOT NULL DEFAULT nextval('mensagens_id_seq'::regclass),
  conversa_id integer NOT NULL,
  texto text NOT NULL,
  criado_em timestamp without time zone DEFAULT now(),
  status character varying DEFAULT 'enviada'::character varying,
  whatsapp_id character varying,
  direcao text NOT NULL DEFAULT 'in'::text,
  autor_usuario_id bigint,
  company_id integer,
  CONSTRAINT mensagens_pkey PRIMARY KEY (id),
  CONSTRAINT mensagens_conversa_fk FOREIGN KEY (conversa_id) REFERENCES public.conversas(id),
  CONSTRAINT mensagens_company_fk FOREIGN KEY (company_id) REFERENCES public.empresas(id)
);
CREATE TABLE public.planos (
  id integer NOT NULL DEFAULT nextval('planos_id_seq'::regclass),
  nome character varying,
  limite_atendentes integer,
  limite_conversas integer,
  limite_mensagens integer,
  preco_mensal numeric,
  criado_em timestamp without time zone DEFAULT now(),
  CONSTRAINT planos_pkey PRIMARY KEY (id)
);
CREATE TABLE public.tags (
  id integer NOT NULL DEFAULT nextval('tags_id_seq'::regclass),
  nome character varying NOT NULL UNIQUE,
  cor text,
  company_id integer,
  CONSTRAINT tags_pkey PRIMARY KEY (id),
  CONSTRAINT tags_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.empresas(id)
);
CREATE TABLE public.users (
  id uuid NOT NULL,
  nome text NOT NULL,
  telefone text,
  criado_em timestamp with time zone DEFAULT now(),
  CONSTRAINT users_pkey PRIMARY KEY (id),
  CONSTRAINT users_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id)
);
CREATE TABLE public.usuarios (
  id integer NOT NULL DEFAULT nextval('usuarios_id_seq'::regclass),
  nome character varying NOT NULL,
  email character varying NOT NULL UNIQUE,
  senha_hash text NOT NULL,
  perfil character varying NOT NULL,
  ativo boolean DEFAULT true,
  criado_em timestamp without time zone DEFAULT now(),
  company_id integer,
  departamento_id integer,
  CONSTRAINT usuarios_pkey PRIMARY KEY (id),
  CONSTRAINT usuarios_departamento_id_fkey FOREIGN KEY (departamento_id) REFERENCES public.departamentos(id),
  CONSTRAINT fk_usuarios_empresa FOREIGN KEY (company_id) REFERENCES public.empresas(id)
);