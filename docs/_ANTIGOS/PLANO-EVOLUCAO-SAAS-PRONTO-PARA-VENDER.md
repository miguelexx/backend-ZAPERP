# Plano de Evolução — ZapERP SaaS Pronto para Vender

**Documento:** Plano estratégico de evolução do sistema WhatsApp corporativo para produto SaaS comercial  
**Autor:** Arquitetura Sênior — Software, Produto SaaS, UX e Compliance  
**Data:** Março 2025  
**Status:** Proposta — Não implementar mudanças invasivas; preservar o que funciona

---

## 1. Resumo Executivo do Produto

**ZapERP** é um sistema de atendimento corporativo via WhatsApp com Z-API que já contempla:
- Triagem automática por chatbot com menu de setores
- Atendimento humano com fila, assumir e transferir
- Regras automáticas por palavra-chave
- Multi-tenant (uma instância Z-API por empresa)
- Dashboard com métricas e relatórios (conversas, mensagens, SLA)
- Permissões granulares (admin, supervisor, atendente)

**Proposta de valor comercial:**
> *"Centralize seu atendimento no WhatsApp. Triagem inteligente, filas por setor, métricas em tempo real e conformidade com as melhores práticas."*

**Posicionamento:** SaaS B2B para pequenas e médias empresas que precisam de atendimento profissional via WhatsApp, sem complexidade de ERP nem custo de soluções enterprise.

---

## 2. Diagnóstico do Sistema Atual

### 2.1 Stack e Arquitetura
| Componente | Tecnologia | Status |
|------------|------------|--------|
| Backend | Node.js, Express | ✅ Estável |
| Banco | Supabase (PostgreSQL) | ✅ Estável |
| Real-time | Socket.IO com auth JWT | ✅ Funcional |
| Integração | Z-API (multi-tenant via `empresa_zapi`) | ✅ Operacional |
| Webhooks | POST /webhooks/zapi | ✅ Sem bloqueio para chatbot |
| Rate limit | 300 req/min API, 200 req/min webhook | ✅ Adequado |
| Autenticação | JWT, company_id em token | ✅ Multi-tenant |

### 2.2 Módulos Existentes
| Módulo | Funcionalidade | Integração |
|--------|----------------|------------|
| **Chatbot triagem** | Menu de setores, boas-vindas, opção inválida, confirmação, transferência por departamento | Webhook Z-API → `chatbotTriageService` |
| **Regras automáticas** | Palavra-chave → resposta, `horario_comercial_only` | `iaController` + `regras_automaticas` — *não integrado ao webhook de recebimento* |
| **Conversas** | Lista, filtros, assumir, transferir, encerrar, tags | `chatController` |
| **Mensagens** | Envio texto/arquivo, reply, status (ticks) | Via API e Z-API |
| **Dashboard** | Overview, métricas, conversas por setor, SLA, export CSV/XLSX/PDF | `dashboardController` |
| **Configurações** | Empresa, horário, SLA, departamentos, respostas salvas, IA | `configController`, `iaController` |
| **Usuários** | CRUD, perfis, permissões granulares | `userController`, `permissoesService` |
| **Integrações** | Status Z-API, QR Code, conectar | `zapiIntegrationController` |
| **Jobs** | Timeout inatividade, reabertura automática | `jobsController` |

### 2.3 Gaps Identificados
| Gap | Impacto |
|-----|---------|
| **Regras automáticas não processadas no webhook** | Configuradas na IA mas não disparadas ao receber mensagem |
| **Sem módulo de campanhas** | Impossível disparar para base com consentimento |
| **Sem opt-in/opt-out** | Risco de não conformidade em mensagens comerciais |
| **Sem controle de frequência** | Risco operacional e reputação do número |
| **Frontend básico** | Aparência genérica; pouco premium para venda SaaS |
| **Onboarding fragmentado** | Sem fluxo guiado para novo cliente |
| **Métricas limitadas** | Falta taxa de resposta, volume enviado/recebido, score de saúde |
| **Sem feature flags** | Difícil liberar recursos por plano gradualmente |

---

## 3. O Que Já Está Bom e Deve Ser Preservado

- **Webhook Z-API:** Resolução `instanceId → company_id`, suporte a grupos, LID, espelhamento de mensagens enviadas pelo celular.
- **Chatbot de triagem:** `processIncomingMessage`, menu numérico, `sendOnlyFirstTime`, `reopenMenuCommand`, distribuição fila/round_robin/menor_carga.
- **Envio em conversa em fila:** Permitido sem assumir — essencial para chatbot e triagem.
- **Permissões:** `permissoesCatalogo`, `usuario_permissoes`, perfis admin/supervisor/atendente.
- **Multi-tenant:** `empresa_zapi` por company, webhook sem token fixo em ENV.
- **SLA:** `sla_minutos_sem_resposta`, alertas de conversa sem resposta.
- **Timeout inatividade:** Job fecha conversas automaticamente.
- **Dashboard:** KPIs, conversas por setor, tempo médio primeira resposta, export.
- **Respostas salvas:** Por setor, integradas à exclusão de departamentos.
- **Rotas e controllers:** Estrutura clara, sem refatoração invasiva necessária.

---

## 4. Gaps para o Sistema Ficar Vendável

| Prioridade | Gap | Solução |
|------------|-----|---------|
| P0 | Módulo de campanhas com conformidade | Novas tabelas + APIs + tela; opt-in/opt-out obrigatório |
| P0 | Opt-in/opt-out formal | `contato_opt_in`, `contato_opt_out`; validação antes de envio comercial |
| P1 | Regras automáticas no webhook | Chamar `regras_automaticas` no fluxo de mensagem recebida (antes ou após chatbot) |
| P1 | Frontend premium | Melhorar login, dashboard, conversas, estados vazios, consistência visual |
| P1 | Onboarding guiado | Checklist de ativação, wizard de conexão Z-API, primeiros passos |
| P2 | Controles de risco | Módulos opcionais: frequência, volume, duplicação, qualidade (conforme PROTEÇÃO-OPERACIONAL) |
| P2 | Métricas avançadas | Taxa de resposta, volume por período, score de saúde |
| P2 | Configurações por empresa centralizadas | Tela única de "Configurações da empresa" com seções |
| P3 | Planos e assinatura | `planos` já existe; vincular recursos por plano, feature flags |

---

## 5. Melhorias Prioritárias de Backend

### 5.1 Regras Automáticas no Webhook (complementar, não invasivo)
- **Onde:** Após persistir mensagem recebida e antes de `processChatbotTriage` (ou em paralelo conforme ordem desejada).
- **O que:** Buscar `regras_automaticas` ativas; se `palavra_chave` contida no texto (case-insensitive); respeitar `horario_comercial_only` com `empresas.horario_inicio/fim`; enviar `resposta` via Z-API; aplicar tag/departamento se configurado; log em `bot_logs`.
- **Arquivo sugerido:** `services/regrasAutomaticasService.js` (novo); chamado no `webhookZapiController.receberZapi` após obter `company_id` e antes do chatbot — **opcional via flag** `ia_config.config.regras_automaticas.enabled`.

### 5.2 Módulo de Campanhas (novo, desacoplado)
- **Tabelas sugeridas:**
  - `campanhas`: id, company_id, nome, status (rascunho|agendada|em_andamento|pausada|encerrada), tipo (promocional|informativa|reengajamento), texto_template, filtros_json, criado_em, agendado_para, encerrado_em
  - `campanha_envios`: id, campanha_id, cliente_id, status (pendente|enviado|entregue|erro|opt_out), enviado_em, erro_msg
  - `contato_opt_in`: id, cliente_id, company_id, origem, criado_em, ativo
  - `contato_opt_out`: id, cliente_id, company_id, criado_em, motivo, canal
- **Serviço:** `services/campanhaService.js` — valida opt-in, opt-out, limita por contato/dia, enfileira envios.
- **Controller:** `campanhaController.js` — CRUD campanhas, listar envios, pausar/retomar.
- **Integração:** Job assíncrono para processar fila de envio; rate limit por empresa.

### 5.3 Módulo de Proteção (opcional, desacoplado)
- Conforme `PROTEÇÃO-OPERACIONAL-WHATSAPP-ZAPI.md`:
  - `services/protecao/optInService.js` — verificar consentimento antes de envio comercial
  - `services/protecao/frequenciaService.js` — intervalo mínimo entre mensagens por contato
  - `services/protecao/volumeService.js` — limite por minuto/hora por empresa
  - `services/protecao/duplicacaoService.js` — job para detectar mensagens repetidas em massa (alerta, não bloqueio)
  - `services/protecao/qualidadeService.js` — score de texto (assin-crono)
- **Política:** Ativado por `empresa_config.protecao_enabled` ou ENV; falha no módulo **não** impede envio.

### 5.4 Endpoint de Métricas Avançadas
- **Rota:** `GET /api/dashboard/metrics-avancadas?range_days=7`
- **Retorno sugerido:** volume_enviado, volume_recebido, taxa_resposta_24h, conversas_novos_contatos, setores_mais_acionados, horario_pico, alertas_recentes.
- **Implementação:** `dashboardController` — novo método; consultas read-only sobre `mensagens`, `conversas`, `clientes`.

---

## 6. Melhorias Prioritárias de Frontend

### 6.1 Tela de Login
- Layout limpo, logo da empresa, campo email/senha, botão "Entrar".
- Estados: loading, erro (toast), link "Esqueci a senha" (futuro).
- Sugestão visual: fundo neutro, card centralizado, sombra leve.

### 6.2 Dashboard
- Cards de KPI (conversas hoje, tempo médio, SLA, tickets abertos) com ícones e cores consistentes.
- Gráficos: conversas por hora, por setor; uso de lib leve (Chart.js ou similar).
- Filtro de período (7, 15, 30 dias).
- Estado vazio quando sem dados: ilustração + mensagem "Nenhuma conversa no período".

### 6.3 Tela de Conversas
- Lista à esquerda (estilo WhatsApp Web): avatar, nome, última mensagem, badge de não lidas.
- Chat à direita: mensagens em bolhas, input com suporte a arquivo, indicador "digitando".
- Estados vazios: "Nenhuma conversa" / "Selecione uma conversa".
- Loader skeleton ao carregar mensagens.

### 6.4 Painel de Chatbot
- Seções: Mensagem de boas-vindas, Opções do menu, Mensagens padrão, Configurações avançadas.
- Preview do menu como o cliente verá.
- Toggle de ativação em destaque.
- Documentação inline (tooltips, ajuda contextual).

### 6.5 Tela de Campanhas (nova)
- Lista de campanhas com status, datas, total de envios.
- Formulário: nome, texto, filtros (tags, último contato), agendamento, validação de opt-in.
- Botões: Salvar rascunho, Agendar, Pausar, Ver relatório.

### 6.6 Consistência Visual
- Design system: cores primárias (`empresas.cor_primaria`), tipografia, espaçamentos, bordas arredondadas.
- Modo dark/light conforme `empresas.tema`.
- Toasts padronizados (sucesso, erro, aviso).
- Modais com overlay e fechamento por ESC.

---

## 7. Melhorias de Chatbot

### 7.1 Complementos Sem Alterar o Core
| Melhoria | Implementação |
|----------|----------------|
| **Mensagem fora do horário** | `ia_config.bot_global.mensagem_fora_horario` — se `businessHoursOnly` e fora de `horario_inicio/fim`, enviar esta mensagem em vez do menu |
| **Fallback para humano** | Se `fallbackToAI` ou comando explícito (ex: "falar com atendente"), transferir para departamento padrão ou setor "Atendimento Geral" |
| **Histórico de interação** | Já existe via `mensagens` e `conversas`; exibir no painel ao lado do chat |
| **Pausa quando humano assume** | Comportamento atual: quando `atendente_id` é definido, o chatbot deixa de processar — **preservar** |
| **Retomada de conversa** | Usar `ultima_atividade` e contexto de `conversa` para sugerir "Retomar conversa anterior" no atendimento |

### 7.2 Templates de Fluxo (novo, opcional)
- **Tabela:** `chatbot_fluxos_templates` (id, nome, segmento, config_json).
- **Exemplos:** "E-commerce", "Clínica/Saúde", "Escola", "Restaurante".
- **Uso:** Na tela de Chatbot, botão "Usar template" que preenche `welcomeMessage` e `options` com valores padrão do segmento.

### 7.3 Biblioteca de Mensagens
- **Tabela:** `mensagens_padrao` (id, company_id, titulo, texto, tipo: boas_vindas|opcao_invalida|confirmacao|fora_horario).
- **Frontend:** Dropdown para escolher mensagem salva ao editar o chatbot.

### 7.4 Painel de Edição Simplificado
- WYSIWYG leve para `welcomeMessage`.
- Arrastar e soltar para reordenar opções do menu.
- Validação em tempo real (opções com mesmo key, departamento vazio).

---

## 8. Melhorias de Campanhas e Disparos com Conformidade

### 8.1 Estrutura Proposta
| Componente | Descrição |
|------------|-----------|
| **Opt-in** | `contato_opt_in`: origem (formulário, site, chat, importação), data, ativo |
| **Opt-out** | `contato_opt_out`: ao receber "PARAR"/"SAIR"/"Descadastrar" no chat ou via comando, inserir registro e excluir de futuras campanhas |
| **Segmentação** | Filtros por tag, último contato (X dias), departamento, nunca comprou |
| **Limitação por contato** | Máx. N mensagens comerciais/dia por cliente (configurável) |
| **Limitação por empresa** | Máx. envios/minuto e/hora (configurável em `empresas`) |
| **Controle de frequência** | Intervalo mínimo entre campanhas para o mesmo contato |
| **Prevenção de duplicidade** | Não enviar mesma campanha duas vezes ao mesmo contato |
| **Exclusão de opt-out** | Lista de campanha exclui sempre `contato_opt_out` |
| **Score de risco** | Cálculo interno: volume + duplicação + taxa de não resposta — apenas alerta |
| **Score de copy** | Análise de texto: excesso de links, emojis, caixa alta — sugestão, não bloqueio |
| **Campanhas pausáveis** | Status `pausada` interrompe fila imediatamente |
| **Logs e auditoria** | `campanha_envios` + `auditoria_envios` (opcional) com motivo e contexto |

### 8.2 Processamento de Opt-out no Webhook
- Ao receber mensagem do cliente, verificar se texto normalizado está em lista de comandos opt-out (`PARAR`, `SAIR`, `DESCADASTRAR`, etc.).
- Se sim: inserir em `contato_opt_out`, enviar mensagem de confirmação única, registrar em `bot_logs`.
- **Serviço:** `services/optOutService.js` — chamado no webhook antes do chatbot.

---

## 9. Melhorias de Compliance e Redução de Risco Operacional

### 9.1 Módulos Opcionais (conforme PROTEÇÃO-OPERACIONAL)
| Módulo | Função | Tipo |
|--------|--------|------|
| Opt-in | Verificar consentimento antes de envio comercial | Validação opcional |
| Frequência | Intervalo mínimo entre mensagens por contato | Validação opcional |
| Volume | Limite por minuto/hora por empresa | Validação opcional |
| Duplicação | Detectar textos iguais para muitos contatos | Job assíncrono, alerta |
| Qualidade | Score de texto (links, emojis, caixa alta) | Análise assíncrona |
| Reputação | Taxa de não resposta, score por operador | Job + painel complementar |
| Higiene conteúdo | Sugestões de melhoria de copy | Retorno não bloqueante |

### 9.2 Configurações por Empresa
- **Novas colunas em `empresas` (migration opcional):**
  - `protecao_enabled` (boolean)
  - `limite_envios_por_minuto` (int)
  - `limite_envios_por_hora` (int)
  - `limite_mensagens_por_contato_dia` (int)
  - `intervalo_minimo_entre_mensagens_seg` (int)
- **Feature flag:** `FEATURE_PROTECAO` em ENV para habilitar módulos globalmente.

### 9.3 Alertas Sugeridos (read-only, painel)
- Pico anormal de envios
- Muitas mensagens iguais em curto período
- Alto volume para contatos sem resposta
- Reenvios insistentes ao mesmo contato
- Operador com padrão arriscado

---

## 10. Melhorias de UX e Visual Premium

### 10.1 Princípios
- **Clareza:** Hierarquia de informação, labels em português claro.
- **Consistência:** Mesmo padrão de botões, cards, formulários em todo o sistema.
- **Feedback:** Loading states, toasts, confirmações antes de ações destrutivas.
- **Acessibilidade:** Contraste adequado, foco visível, labels em inputs.

### 10.2 Inspirações
- **Conversas:** WhatsApp Web — listas compactas, bolhas de mensagem, ícones de status.
- **Gestão:** CRMs como HubSpot, Pipedrive — cards de métricas, tabelas limpas.
- **SaaS B2B:** Linear, Notion, Vercel — minimalismo, tipografia forte, dark mode elegante.

### 10.3 Componentes Sugeridos
- `EmptyState`: ilustração + título + descrição + CTA opcional
- `MetricCard`: valor grande, label, variação (opcional), ícone
- `DataTable`: ordenação, paginação, ações em linha
- `ConfirmModal`: título, mensagem, botões Cancelar/Confirmar
- `Toast`: sucesso (verde), erro (vermelho), aviso (amarelo)
- `Skeleton`: loading para listas e cards

### 10.4 Responsividade
- Mobile-first para painel administrativo (não para chat — chat em desktop recomendado).
- Sidebar colapsável em telas menores.
- Tabelas com scroll horizontal quando necessário.

---

## 11. Estrutura Ideal de Módulos do Produto

| Módulo | Descrição | Incluso em |
|--------|-----------|------------|
| **Atendimento** | Conversas, assumir, transferir, encerrar, tags | Todos |
| **Chatbot** | Triagem, menu setores, regras automáticas | Básico+ |
| **Campanhas** | Disparos com opt-in, segmentação, limites | Profissional, Enterprise |
| **CRM básico** | Clientes, observações, histórico | Todos |
| **Relatórios** | Dashboard, export CSV/XLSX/PDF, métricas avançadas | Todos (métricas avançadas em Profissional+) |
| **Configurações** | Empresa, horário, setores, respostas salvas | Admin |
| **Usuários e permissões** | CRUD, perfis, granular | Admin |
| **Integrações** | Z-API, status, QR Code | Admin |
| **Auditoria** | Logs de atendimentos, alterações de config | Profissional+ |
| **Proteção operacional** | Opt-in, frequência, volume, alertas | Profissional, Enterprise |

---

## 12. Estrutura Ideal de Configurações por Empresa

### 12.1 Navegação Sugerida
```
Configurações
├── Empresa (nome, logo, horário, tema, cor)
├── WhatsApp (perfil: foto, nome, descrição)
├── Setores (departamentos)
├── Usuários
├── Chatbot (IA > Config)
├── Respostas automáticas (regras palavra-chave)
├── Respostas salvas
├── Campanhas (limites, opt-out padrão)
├── Proteção (módulos opcionais)
├── Integrações (Z-API)
├── Assinatura / Plano
└── Permissões (admin)
```

### 12.2 Agrupamento Lógico
- **Geral:** Empresa, WhatsApp, Assinatura
- **Operação:** Setores, Usuários, Permissões
- **Automação:** Chatbot, Regras automáticas, Respostas salvas
- **Campanhas:** Config de campanhas, opt-out
- **Segurança:** Proteção operacional
- **Integrações:** Z-API

---

## 13. Estrutura Ideal de Métricas e Relatórios

### 13.1 Visão Executiva
- Conversas no período
- Tempo médio de primeira resposta
- SLA (% respondidas no prazo)
- Taxa de conversão (fechadas/total)
- Volume enviado vs recebido
- Novos contatos
- Atendente mais produtivo

### 13.2 Visão Operacional
- Conversas por setor
- Conversas por atendente
- Conversas por hora (pico)
- Mensagens por tipo (texto, áudio, imagem)
- Alertas SLA (conversas sem resposta)
- Campanhas enviadas e taxa de resposta (quando houver)
- Templates mais usados
- Setores mais acionados

### 13.3 Score de Saúde (opcional)
- Agregação: taxa de resposta, ausência de picos anômalos, opt-out rate, duplicação detectada.
- Exibição: indicador verde/amarelo/vermelho no dashboard.

---

## 14. Estrutura Ideal de Usuários, Perfis e Governança

### 14.1 Perfis Existentes (preservar)
| Perfil | Acesso |
|--------|--------|
| Admin | Tudo |
| Supervisor | Config (sem WhatsApp), IA, dashboard, integrações, usuários (sem excluir) |
| Atendente | Clientes, atendimentos, tags |

### 14.2 Permissões Adicionais Sugeridas
| Código | Nome | Perfis |
|--------|------|--------|
| `campanhas.ver` | Ver campanhas | admin, supervisor |
| `campanhas.criar` | Criar campanha | admin, supervisor |
| `campanhas.enviar` | Enviar/agendar campanha | admin |
| `campanhas.relatorio` | Ver relatório de campanha | admin, supervisor |
| `relatorios.exportar` | Exportar relatórios | admin, supervisor |
| `auditoria.ver` | Ver logs de auditoria | admin |

### 14.3 Auditoria
- **Tabela:** `auditoria_log` (id, company_id, usuario_id, acao, entidade, entidade_id, detalhes_json, criado_em).
- **Ações a registrar:** alteração de config, criação de campanha, envio em massa, alteração de permissões, exclusão de dados.
- **Integração:** Chamadas opcionais em controllers críticos; **não** em toda requisição para evitar overhead.

---

## 15. Plano de Evolução em Fases

### Fase 1: Mínimo para vender (4–6 semanas)
### Fase 2: Profissionalização operacional (6–8 semanas)
### Fase 3: Escala e inteligência de produto (8–12 semanas)

---

## 16. Fase 1 — O Mínimo para Vender

| # | Item | Tipo | Prioridade |
|---|------|------|------------|
| 1 | Integrar regras automáticas no webhook | Backend (opcional) | P0 |
| 2 | Processar opt-out no webhook (comandos PARAR, SAIR) | Backend | P0 |
| 3 | Tabelas `contato_opt_in`, `contato_opt_out` | Migration | P0 |
| 4 | Melhorar tela de login (visual premium) | Frontend | P1 |
| 5 | Melhorar dashboard (cards, gráficos, empty states) | Frontend | P1 |
| 6 | Tela Configurações unificada (seções) | Frontend | P1 |
| 7 | Onboarding: checklist de ativação (conectar Z-API, criar setor, ativar chatbot) | Frontend | P1 |
| 8 | Documentação inline (tooltips na tela de Chatbot) | Frontend | P2 |
| 9 | Estado vazio consistente (EmptyState) | Frontend | P2 |
| 10 | Toasts e loaders padronizados | Frontend | P2 |

**Entregável Fase 1:** Sistema visualmente profissional, onboarding claro, regras automáticas funcionando, opt-out básico. Pronto para demonstração comercial.

---

## 17. Fase 2 — Profissionalização Operacional

| # | Item | Tipo | Prioridade |
|---|------|------|------------|
| 1 | Módulo de campanhas completo | Backend + Frontend | P0 |
| 2 | CRUD campanhas, segmentação, agendamento | Backend | P0 |
| 3 | Job de envio em fila com rate limit | Backend | P0 |
| 4 | Tela de campanhas (lista, criar, relatório) | Frontend | P0 |
| 5 | Módulo de proteção (frequência, volume) | Backend (opcional) | P1 |
| 6 | Métricas avançadas (taxa resposta, volume) | Backend | P1 |
| 7 | Painel de proteção/monitoramento | Frontend | P2 |
| 8 | Chatbot: mensagem fora do horário | Backend | P1 |
| 9 | Chatbot: templates por segmento | Backend + Frontend | P2 |
| 10 | Biblioteca de mensagens padrão | Backend + Frontend | P2 |
| 11 | Tela de relatórios aprimorada | Frontend | P1 |
| 12 | Auditoria de ações críticas | Backend | P2 |

**Entregável Fase 2:** Campanhas com conformidade, proteção operacional opcional, métricas profissionais. Produto pronto para operação em escala.

---

## 18. Fase 3 — Escala e Inteligência de Produto

| # | Item | Tipo | Prioridade |
|---|------|------|------------|
| 1 | Feature flags por plano | Backend | P1 |
| 2 | Planos com recursos diferenciados | Backend | P1 |
| 3 | Score de saúde operacional | Backend | P2 |
| 4 | Alertas proativos (pico, duplicação, insistência) | Backend | P2 |
| 5 | Módulos qualidade e reputação | Backend | P2 |
| 6 | Dashboard executivo (BI leve) | Frontend | P2 |
| 7 | API pública para integrações | Backend | P3 |
| 8 | Webhooks de evento (campanha enviada, opt-out) | Backend | P3 |
| 9 | White-label (logo, cor por empresa) | Frontend | P2 |
| 10 | Multi-idioma (pt-BR, en) | Frontend | P3 |

**Entregável Fase 3:** Produto escalável, diferenciado por plano, pronto para parceiros e white-label.

---

## 19. Sugestão de Telas e Componentes

### 19.1 Telas
| Tela | Rota sugerida | Componentes principais |
|------|---------------|-------------------------|
| Login | `/login` | Form, Toast |
| Dashboard | `/` ou `/dashboard` | MetricCard, Chart, DataTable |
| Conversas | `/conversas` | ChatList, ChatPanel, MessageBubble |
| Campanhas | `/campanhas` | CampaignList, CampaignForm, CampaignReport |
| Chatbot | `/config/chatbot` | ChatbotConfig, OptionEditor, Preview |
| Configurações | `/config` | ConfigSections, EmpresaForm, Integrations |
| Usuários | `/usuarios` | UserList, UserForm, PermissaoModal |
| Relatórios | `/relatorios` | ReportFilters, ExportButton, DataTable |

### 19.2 Componentes Reutilizáveis
- `MetricCard`, `EmptyState`, `Skeleton`, `ConfirmModal`
- `DataTable`, `SearchInput`, `DateRangePicker`
- `Toast` (context), `Sidebar`, `Header`
- `ChatMessage`, `ChatInput`, `TypingIndicator`

---

## 20. Sugestão de Tabelas/Entidades Opcionais

| Tabela | Propósito | Quando criar |
|--------|-----------|--------------|
| `campanhas` | Disparos em massa | Fase 2 |
| `campanha_envios` | Registro por envio | Fase 2 |
| `contato_opt_in` | Consentimento | Fase 1 |
| `contato_opt_out` | Descadastro | Fase 1 |
| `auditoria_log` | Trilha de auditoria | Fase 2 |
| `chatbot_fluxos_templates` | Templates por segmento | Fase 2 |
| `mensagens_padrao` | Biblioteca de mensagens | Fase 2 |
| `empresa_config` ou colunas em `empresas` | Proteção, limites | Fase 2 |
| `feature_flags` | Recursos por plano | Fase 3 |
| `webhook_eventos` | Eventos para integrações | Fase 3 |

---

## 21. Sugestão de APIs/Serviços Complementares

| Endpoint | Método | Descrição |
|----------|--------|-----------|
| `/api/campanhas` | GET, POST | Listar, criar campanha |
| `/api/campanhas/:id` | GET, PUT, DELETE | Detalhe, atualizar, excluir |
| `/api/campanhas/:id/pausar` | POST | Pausar envio |
| `/api/campanhas/:id/retomar` | POST | Retomar envio |
| `/api/campanhas/:id/envios` | GET | Listar envios da campanha |
| `/api/opt-in` | POST | Registrar opt-in manual |
| `/api/opt-out` | GET | Listar opt-outs |
| `/api/dashboard/metrics-avancadas` | GET | Métricas extras |
| `/api/protecao/alertas` | GET | Alertas de risco (read-only) |
| `/api/auditoria` | GET | Logs de auditoria |

---

## 22. Sugestão de Feature Flags

| Flag | Descrição | Valores |
|------|-----------|---------|
| `FEATURE_CAMPANHAS` | Habilitar módulo de campanhas | 0 \| 1 |
| `FEATURE_PROTECAO` | Habilitar módulos de proteção | 0 \| 1 |
| `FEATURE_REGRA_AUTO_WEBHOOK` | Processar regras automáticas no webhook | 0 \| 1 |
| `FEATURE_OPT_OUT_WEBHOOK` | Processar comandos opt-out no webhook | 0 \| 1 |
| `FEATURE_METRICAS_AVANCADAS` | Endpoint de métricas avançadas | 0 \| 1 |
| Por plano: `plano.campanhas`, `plano.protecao` | Recursos por assinatura | JSON em `planos` |

---

## 23. Riscos do Projeto e Como Mitigar

| Risco | Mitigação |
|-------|-----------|
| Quebrar webhook ou chatbot | Todas as alterações são complementares; testes em staging antes de produção |
| Regras automáticas conflitarem com chatbot | Definir ordem clara: opt-out → regras → chatbot; regras podem rodar antes do menu |
| Campanhas gerarem bloqueio pelo WhatsApp | Limites conservadores, opt-in obrigatório, rate limit por empresa |
| Performance com muitas empresas | Índices em `company_id`, `criado_em`; jobs assíncronos para envio |
| Complexidade de configuração | Onboarding guiado, defaults sensatos, documentação inline |
| Conflito entre refatoração e evolução | Regra absoluta: não refatorar core; apenas adicionar camadas |

---

## 24. O Que NÃO Deve Ser Feito

- **Não** alterar rotas, controllers ou serviços existentes de forma invasiva
- **Não** remover ou modificar comportamento do `chatbotTriageService` que já funciona
- **Não** implementar técnicas de evasão, anti-detecção ou mascaramento
- **Não** criar disparos sem opt-in ou sem limite de frequência
- **Não** remover permissões já concedidas a perfis
- **Não** alterar `empresa_zapi`, webhooks ou autenticação sem necessidade extrema
- **Não** fazer refatoração ampla do chatController ou webhookZapiController
- **Não** criar spam, listas frias ou envio sem consentimento
- **Não** rotacionar números ou usar múltiplas instâncias para burlar limites

---

## 25. Conclusão Final — Visão de Produto SaaS

O **ZapERP** já possui uma base sólida: atendimento humano, chatbot de triagem, multi-tenant, permissões e dashboard. Os gaps principais estão em:

1. **Conformidade:** Opt-in/opt-out e campanhas responsáveis
2. **Apresentação:** Frontend premium e onboarding claro
3. **Operação:** Controles de risco opcionais e métricas avançadas
4. **Comercialização:** Módulos por plano e feature flags

A estratégia de **evolução incremental** preserva o que funciona e adiciona camadas profissionais de forma desacoplada. Cada melhoria pode ser ativada gradualmente (feature flag, configuração por empresa), reduzindo risco e permitindo validação com clientes antes da adoção em massa.

**Próximos passos recomendados:**
1. Implementar Fase 1 (4–6 semanas) para ter demonstração comercial
2. Validar com 2–3 clientes piloto
3. Entregar Fase 2 para campanhas e proteção
4. Evoluir para Fase 3 conforme demanda e escalabilidade

O sistema está preparado para crescer sem perder estabilidade. A diretriz central permanece: **não quebrar nada do que já funciona**.

---

*Documento gerado com base em análise do codebase ZapERP, docs PROTEÇÃO-OPERACIONAL-WHATSAPP-ZAPI.md, PAGINA-CHATBOT-FRONTEND.md e estrutura de controllers, services e migrations.*
