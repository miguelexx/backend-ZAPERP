# Proteção Operacional e Boas Práticas — WhatsApp Corporativo com Z-API

**Documento:** Proposta de camada adicional de proteção operacional e boas práticas  
**Objetivo:** Reduzir risco de bloqueio, banimento, queda de reputação e comportamento suspeito  
**Escopo:** Análise e sugestões complementares, desacopladas e não invasivas  
**Status:** Sugestões — Sistema otimizado para modo chatbot

---

## MODO CHATBOT — Sistema Otimizado para Receber e Disparar

O sistema foi configurado para **não bloquear facilmente** e ser **totalmente apto para receber e disparar chatbot**.

### Comportamento atual (permissivo para chatbot)

| Aspecto | Comportamento | Observação |
|---------|---------------|------------|
| **Envio em conversas não assumidas** | ✅ Permitido | Quando a conversa está em fila (`atendente_id` null), qualquer usuário autenticado pode enviar — permite respostas durante triagem, chatbot via painel e fluxos automáticos antes de assumir. |
| **Envio em conversas assumidas** | ✅ Quem assumiu pode enviar | Mantém organização quando há atendente humano responsável. |
| **Webhook Z-API** | ✅ Sem exigência de assumir | O chatbot de triagem envia diretamente via Z-API no webhook; não passa pela validação de assumir. |
| **Rate limit API** | 300 req/min | Aumentado para suportar volume de chatbot e integrações. |
| **Rate limit webhook** | 200 req/min | Aumentado para receber alto volume de mensagens do WhatsApp. |
| **Bloqueio de mensagens** | Apenas entre atendentes | Quando conversa está assumida por outro atendente — admin e supervisor veem tudo. |

### Resumo: nada impede o chatbot de funcionar

- **Receber:** Webhook aceita todas as mensagens; chatbot de triagem processa sem bloqueio.
- **Disparar:** Via webhook (chatbot triage) ou via API em conversas em fila — ambos funcionam sem exigir "assumir" antes.
- **Integrações:** Rate limits aumentados para APIs e webhooks não limitarem o fluxo.

---

## REGRAS ABSOLUTAS DESTE DOCUMENTO

- **Não alterar** rotas, controllers, serviços, webhooks, autenticação, filas, banco, frontend ou integrações existentes de forma invasiva.
- **Não implementar** técnicas de evasão, mascaramento, anti-detecção ou disparo abusivo.
- **Não propor** automações abusivas, compra de listas frias ou envio sem consentimento.
- Este documento contém **análise**, **sugestões** e **guias operacionais**. O sistema já está otimizado para modo chatbot conforme acima.

---

## 1. Diagnóstico de Risco Operacional Atual

Com base na análise do codebase do backend WhatsApp + Z-API:

### Pontos já cobertos pelo sistema

| Área | Situação atual | Nível de proteção |
|------|----------------|-------------------|
| **Envio** | Quem assumiu OU conversa em fila (atendente_id null) pode enviar — otimizado para chatbot | Bom |
| **Permissões** | Admin, supervisor e atendente com regras claras | Bom |
| **Rate limit** | 300 req/min API; 200 req/min webhook; 5 tentativas login/min — suporta volume de chatbot | Bom |
| **QR Code / conexão** | Throttle 10s entre QR; bloqueio 60s após 3 tentativas sem conectar | Bom |
| **Timeout inatividade** | Job fecha conversas sem resposta após X minutos configurável | Bom |
| **Limite de chats por atendente** | `limite_chats_por_atendente` configurável por empresa | Bom |
| **SLA sem resposta** | Alerta quando cliente fica mais de X min sem resposta | Bom |
| **Horário comercial** | `horario_inicio` e `horario_fim` em empresas; regras IA podem usar `horario_comercial_only` | Moderado |
| **Regras automáticas** | Palavra-chave → resposta; possibilidade de limitar por horário | Bom |

### Gaps de risco operacional identificados

| Gap | Risco | Severidade |
|-----|-------|------------|
| **Sem opt-in/opt-out formal** | Envio para contatos sem consentimento documentado; violação de políticas WhatsApp | Alta |
| **Sem controle de frequência por contato** | Múltiplas mensagens seguidas; insistência; percepção de spam | Média |
| **Sem limite de volume por minuto/hora** | Pico de envio pode acionar detecção do WhatsApp | Média |
| **Sem validação de histórico de conversa** | Primeiro contato sem contexto prévio; risco de bloqueio/reclamação | Média |
| **Sem detecção de duplicação** | Mesma mensagem enviada em massa para muitos contatos | Média |
| **Sem alertas de qualidade** | Mensagens muito curtas, genéricas ou com padrão de spam | Baixa |
| **Sem auditoria dedicada de envio** | Dificuldade em rastrear quem enviou o quê e quando | Baixa |
| **Sem monitoramento de taxa de resposta** | Não se sabe se mensagens estão sendo ignoradas em massa | Baixa |
| **Sem alertas de pico ou anomalia** | Picos incomuns passam despercebidos | Baixa |

### Resumo do diagnóstico

O sistema está **estável e adequado** para atendimento conversacional. Os principais riscos residem na **ausência de camadas de consentimento, frequência e qualidade**. A proposta não altera o core; apenas sugere **módulos complementares opcionais**.

---

## 2. Pontos de Atenção sem Alterar o Sistema

1. **Opt-in/opt-out:** Hoje não há tabela nem validação. Se houver campanhas ou primeiros contatos, considerar registro manual ou integração futura.
2. **Frequência:** Nenhum intervalo mínimo entre mensagens ou limite por contato. Operadores podem enviar várias mensagens seguidas.
3. **Volume:** API 300 req/min; webhook 200 req/min; não há limite por empresa/instância antes de chamar Z-API.
4. **Horário:** `horario_inicio` e `horario_fim` existem, mas não há bloqueio automático de envio fora da janela no controller.
5. **Regras automáticas:** Funcionam 24h se `horario_comercial_only` estiver desativado.
6. **Links e formato:** Não há verificação de quantidade de links, emojis ou padrão de texto por mensagem.
7. **Duplicação:** Não há detecção de textos idênticos enviados em sequência ou para muitos contatos.
8. **Logs de envio:** `mensagens` registra envios; não há tabela de auditoria específica com motivo, contexto ou campanha.

**Todas as sugestões abaixo são complementares e desacopladas — não mudam o comportamento atual.**

---

## 3. Sugestões Complementares Desacopladas

### 3.1 Módulo de Controles de Risco (sugestão de novos arquivos)

| Arquivo sugerido | Função | Integração |
|------------------|--------|------------|
| `services/protecao/optInService.js` | Verificar consentimento antes de envio | Chamado opcional antes de `sendText` etc. |
| `services/protecao/frequenciaService.js` | Intervalo mínimo entre mensagens; limite por contato | Chamado opcional no fluxo de envio |
| `services/protecao/volumeService.js` | Limite por minuto/hora/dia por empresa | Chamado opcional no fluxo de envio |
| `services/protecao/duplicacaoService.js` | Detectar mensagens repetidas em massa | Job ou webhook pós-envio, sem bloquear |

### 3.2 Módulo de Qualidade e Reputação

| Arquivo sugerido | Função | Integração |
|------------------|--------|------------|
| `services/protecao/qualidadeService.js` | Score de qualidade de texto; alertas para mensagens curtas/genéricas | Análise assíncrona, sem bloquear envio |
| `services/protecao/reputacaoService.js` | Taxa de não resposta; score por operador/setor | Job periódico; painel complementar |

### 3.3 Módulo de Higiene de Conteúdo

| Arquivo sugerido | Função | Integração |
|------------------|--------|------------|
| `services/protecao/higieneConteudoService.js` | Detectar excesso de links, emojis, caixa alta, aparência de spam | Chamado opcional; retorna sugestões, não bloqueia |

### 3.4 Painel de Monitoramento (módulo separado)

- Novas rotas e controller em `protecaoController.js` e `protecaoRoutes.js`.
- Consultas read-only sobre `mensagens` e `conversas` existentes.
- Sem alterar fluxos atuais de envio/recebimento.

### 3.5 Política de Implementação

- Tudo **opcional**: ativado por flag em `empresa_config` ou ENV.
- **Desacoplado**: falha no módulo de proteção não impede envio.
- **Não invasivo**: nenhuma alteração em `chatController`, `zapi.js` ou webhooks existentes; apenas chamadas opcionais ou jobs em paralelo.

---

## 4. Regras de Proteção do Número

1. **Nunca** compartilhar o número ou instância com terceiros para disparos.
2. **Nunca** enviar mensagens em nome de outra empresa sem identificação clara.
3. Usar apenas um provedor (Z-API) por número; evitar múltiplas integrações simultâneas.
4. Não fazer rotação de números para distribuir volume.
5. Evitar reconexões frequentes do QR; respeitar o throttle já existente em `zapiConnectGuardService`.
6. Monitorar status de conexão; em caso de desconexão inesperada, pausar envios até verificar causa.
7. Manter número ativo e verificado; números dormindo podem ser recuperados pelo WhatsApp.
8. Evitar números recém-registrados para alto volume; aquecimento gradual recomendado.

---

## 5. Regras de Qualidade de Mensagem

1. **Clareza:** Mensagens objetivas e compreensíveis.
2. **Contexto:** Referenciar histórico quando possível (ex.: "Sobre seu pedido #123...").
3. **Identificação:** Sempre deixar claro quem está falando (empresa/nome do atendente).
4. **Tamanho mínimo sugerido:** Evitar mensagens de 1–2 palavras; prefira frases completas.
5. **Evitar:** Excesso de emojis (>3–4 por mensagem), caixa alta excessiva, múltiplos pontos de exclamação.
6. **Links:** Preferir 0–1 link por mensagem; se mais, justificar no contexto.
7. **Evitar aparência de template massivo:** Varie o texto; personalize quando possível.
8. **Opt-out visível:** Em mensagens comerciais, incluir forma de descadastro (ex.: "Para parar de receber, digite PARAR").

---

## 6. Regras de Frequência e Volume

### Por contato

- Intervalo mínimo sugerido entre mensagens **do mesmo operador** para o **mesmo contato**: 30–60 segundos.
- Máximo sugerido de mensagens por contato por dia (incluindo reenvios): 5–10, conforme tipo de conversa.
- Em primeiros contatos: 1 mensagem inicial; aguardar resposta antes de insistir.

### Por instância / empresa

- Limite sugerido por minuto: 20–40 mensagens (Z-API e WhatsApp têm limites próprios).
- Limite sugerido por hora: 200–400 mensagens.
- Evitar picos súbitos; distribuir envios ao longo do dia.

### Por operador

- Respeitar `limite_chats_por_atendente` já existente.
- Evitar que um único operador concentre a maior parte do volume; distribuir entre setores.

---

## 7. Regras de Opt-in e Opt-out

### Opt-in (consentimento)

- **Sempre** obter consentimento explícito antes de mensagens promocionais ou de marketing.
- Registrar: data, canal, contexto (formulário, site, chat, etc.).
- Preferir opt-in com dupla confirmação (cliente confirma que quer receber).

### Opt-out (descadastro)

- Oferecer comando simples (ex.: "PARAR", "SAIR", "Descadastrar").
- Ao receber opt-out: parar imediatamente; marcar contato como opt-out; nunca reenviar mensagens comerciais.
- Confirmar o descadastro em uma única mensagem final.

### Implementação sugerida (tabelas novas, opcionais)

- `contato_opt_in`: `cliente_id`, `company_id`, `origem`, `criado_em`, `ativo`.
- `contato_opt_out`: `cliente_id`, `company_id`, `criado_em`, `motivo` (opcional).
- Validação antes do envio: se tipo de mensagem for comercial e contato estiver em opt-out, bloquear (em módulo separado).

---

## 8. Alertas e Monitoramento

### Alertas sugeridos (não invasivos)

| Alerta | Condição | Ação sugerida |
|--------|----------|---------------|
| Pico anormal de envios | >X mensagens em Y minutos (ex.: 80 em 5 min) | Notificar supervisor; log |
| Muitas mensagens iguais | Mesmo texto enviado para >N contatos em período curto | Alerta de risco; sugerir variação |
| Alto volume para contatos sem resposta | >Z% dos últimos envios sem resposta em 24h | Revisar abordagem; reduzir frequência |
| Concentração de links | >2 links em mensagens recentes em alta proporção | Sugerir redução de links |
| Muitos contatos novos em pouco tempo | Pico de novas conversas em 1h | Verificar se é esperado; monitorar |
| Taxa de resposta em queda | Comparação com período anterior | Revisar qualidade e timing |
| Reenvios insistentes | Mesmo contato recebeu >3 mensagens em 1h sem responder | Sugerir parar de insistir |
| Operador com padrão arriscado | Operador com muitos dos indicadores acima | Revisão com supervisor |

### Métricas sugeridas para painel complementar

- Volume enviado por hora/dia (por empresa, por operador, por setor).
- Contatos acionados por período.
- Taxa de resposta (mensagens com resposta em X horas).
- Taxa de continuidade (conversas que seguem após primeira troca).
- Ranking de textos/templates mais usados.
- Contatos sem opt-in (quando houver tabela).
- Contatos com tentativa excessiva.
- Campanhas/fluxos com padrão repetitivo.
- Score geral de saúde do número (agregação dos indicadores acima).

---

## 9. Checklist para Operadores

### Antes de enviar

- [ ] Conversa está assumida por mim?
- [ ] Horário é adequado? (evitar madrugada e muito tarde)
- [ ] Mensagem é clara e útil para o cliente?
- [ ] Contato tem histórico recente ou é primeiro contato? (se primeiro, ter cuidado extra)
- [ ] Evito excesso de links, emojis e caixa alta?

### Durante o atendimento

- [ ] Respeito intervalo entre mensagens (não disparar várias seguidas).
- [ ] Uso linguagem profissional e empática.
- [ ] Respondo no tempo adequado (dentro do SLA configurado).

### Após silêncio ou rejeição

- [ ] Se o cliente não responde há tempo: não insistir além de 1–2 follow-ups.
- [ ] Se o cliente pediu para parar: parar imediatamente e registrar opt-out.
- [ ] Não reenviar mensagens comerciais para quem pediu descadastro.

### Primeiro contato

- [ ] Identificar claramente a empresa e o motivo do contato.
- [ ] Oferecer valor imediato (informação útil, não apenas propaganda).
- [ ] Incluir opção de opt-out.
- [ ] Uma mensagem inicial; aguardar resposta antes de insistir.

---

## 10. Gatilhos Comerciais Seguros para Copy

Apenas como boas práticas de escrita, nunca como técnica de spam:

| Gatilho | Uso seguro | Evitar |
|---------|------------|--------|
| **Clareza** | Mensagens diretas e fáceis de entender | Jargão, ambiquidade |
| **Utilidade** | Informação que resolve dúvida ou ajuda | Mensagem vazia, só propaganda |
| **Prova social moderada** | Menção a depoimentos ou casos reais, sem exagero | "Milhares de clientes!" sem contexto |
| **Urgência real** | Prazo de oferta, estoque limitado real | "Última chance!" falso, repetido |
| **Escassez real** | Vagas, cupons ou estoque de fato limitados | Inventar escassez |
| **Personalização** | Nome, histórico, contexto do cliente | Template idêntico para todos |
| **Continuidade** | Retomar assunto anterior com naturalidade | Ignorar histórico |
| **Retomada contextual** | "Sobre sua solicitação de ontem..." | Mensagem genérica sem contexto |
| **Educação do cliente** | Explicar benefício ou como usar | Pressão de venda |
| **CTA leve** | Convite claro para próxima ação, sem pressão | "Compre agora!!!" insistente |

---

## 11. Exemplos de Mensagens Mais Saudáveis

### Ruim (evitar)

> "!!! OFERTA IMPERDÍVEL !!! Acesse agora: link1 link2 link3 🔥🔥🔥 COMPRE JÁ!!!"

### Melhor

> "Olá, [Nome]! Temos uma condição especial para você esta semana. Quer saber mais? Se não tiver interesse, responda PARAR."

### Ruim (evitar)

> "Oi"
> "Tudo bem?"
> "Precisa de ajuda?"

### Melhor

> "Olá! Vi que você entrou em contato conosco. Em que posso ajudar?"

### Ruim (evitar)

> "Promoção relâmpago!!! ÚLTIMA CHANCE!!! Só HOJE!!!"

### Melhor

> "Olá! Nossa promoção de [ produto ] termina sexta-feira. Posso te enviar os detalhes?"

---

## 12. O que NÃO Fazer em Hipótese Alguma

1. **Não** enviar mensagens promocionais sem opt-in.
2. **Não** insistir após o cliente pedir para parar.
3. **Não** usar listas de contatos compradas ou obtidas sem consentimento.
4. **Não** simular comportamento humano com bots (digitando falso, delays artificiais em massa).
5. **Não** rotacionar números para burlar limites.
6. **Não** usar técnicas de evasão ou mascaramento de conteúdo.
7. **Não** enviar em horários inadequados (madrugada, muito tarde).
8. **Não** disparar a mesma mensagem para centenas de contatos sem variação.
9. **Não** usar excesso de links, emojis ou caixa alta.
10. **Não** criar urgência ou escassez falsas.
11. **Não** ignorar denúncias ou bloqueios; investigar e ajustar.
12. **Não** alterar o sistema atual para implementar estas sugestões de forma invasiva.

---

## Reforços Finais

- O sistema está **otimizado para modo chatbot**: envio sem assumir em conversas em fila, rate limits ampliados, webhook sem bloqueios.
- Módulos de proteção opcional (opt-in, frequência, etc.) devem ser **camada opcional**, **desacoplada** e **segura**.
- O objetivo é **conformidade**, **reputação** e **operação saudável** do número WhatsApp, sem impedir o funcionamento do chatbot.
- Este documento serve como **referência operacional** e **base para futuras implementações** quando e se a equipe decidir incorporar proteções adicionais.

---

*Documento gerado em análise de arquitetura e compliance para WhatsApp corporativo com Z-API. Sistema configurado para não bloquear chatbot — receber e disparar em fluxo contínuo.*
