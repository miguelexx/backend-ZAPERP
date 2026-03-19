# Prompt Frontend — Chatbot de Triagem (Completo e Definitivo)

> **Objetivo:** Implementar a página "Chatbot de Triagem" completa e remover a aba "Bot global" do sistema. Todo o controle de chatbot passa a viver exclusivamente em "Chatbot de Triagem".

---

## O QUE FAZER

1. **Remover a aba "Bot global"** da navegação/tabs da página de IA/Chatbot. Ela não existe mais.
2. **Implementar (ou completar) a aba "Chatbot de Triagem"** com todas as seções listadas abaixo.
3. **Não criar aba separada** para "fora do horário" — tudo fica dentro do "Chatbot de Triagem".

---

## APIs

### Buscar configuração
```
GET /api/ia/config
Authorization: Bearer <token>
```

Resposta — o frontend usa apenas `chatbot_triage`:
```json
{
  "chatbot_triage": {
    "enabled": false,
    "welcomeMessage": "",
    "invalidOptionMessage": "Opção inválida. Por favor, responda apenas com o número do setor desejado.",
    "confirmSelectionMessage": "Perfeito! Seu atendimento foi direcionado para o setor {{departamento}}. Em instantes nossa equipe dará continuidade.",
    "intervaloEnvioSegundos": 3,
    "sendOnlyFirstTime": true,
    "fallbackToAI": false,
    "businessHoursOnly": false,
    "transferMode": "departamento",
    "tipo_distribuicao": "fila",
    "reopenMenuCommand": "0",
    "options": [],
    "enviarMensagemFinalizacao": false,
    "mensagemFinalizacao": "Atendimento finalizado com sucesso. (Segue seu protocolo: {{protocolo}}.\nPor favor, informe uma nota entre 0 e 10 para avaliar o atendimento prestado.)",
    "foraHorarioEnabled": false,
    "horarioInicio": "09:00",
    "horarioFim": "18:00",
    "mensagemForaHorario": "Olá! Nosso horário de atendimento é de segunda a sexta, das 09h às 18h. Sua mensagem foi recebida e retornaremos no próximo dia útil. Obrigado!",
    "diasSemanaDesativados": [0, 6],
    "datasEspecificasFechadas": []
  }
}
```

### Salvar configuração
```
PUT /api/ia/config
Authorization: Bearer <token>
Content-Type: application/json

{ "chatbot_triage": { ...campos... } }
```
O backend faz merge — pode enviar apenas os campos alterados.

### Listar departamentos (para dropdowns)
```
GET /api/dashboard/departamentos
Authorization: Bearer <token>
```
Retorna: `[{ id, nome, company_id }]`

### Logs do bot
```
GET /api/ia/logs?limit=50
Authorization: Bearer <token>
```
Retorna: `[{ id, conversa_id, tipo, detalhes, criado_em }]`
Tipos: `menu_enviado`, `opcao_valida`, `opcao_invalida`, `menu_reenviado`, `fora_horario`

---

## ESTRUTURA DA PÁGINA — Chatbot de Triagem

A página é dividida em **6 seções** em sequência (não tabs separadas):

---

### SEÇÃO 1 — Ativar chatbot + Mensagem de boas-vindas

```
┌─────────────────────────────────────────────────────────────┐
│  Chatbot de Triagem                              [Ativar ○] │
├─────────────────────────────────────────────────────────────┤
│  Mensagem de boas-vindas                                     │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Olá! Seja bem-vindo(a)...                           │   │
│  │ 1 - Atendimento                                     │   │
│  │ 2 - Vendas                                          │   │
│  │ Responda com o número da opção desejada.            │   │
│  └─────────────────────────────────────────────────────┘   │
│  (textarea, 4-6 linhas)                                     │
│                                                             │
│  Mensagem quando o cliente digita opção errada              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Opção inválida. Por favor, responda apenas com...   │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  Mensagem de confirmação (use {{departamento}})             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Perfeito! Seu atendimento foi direcionado para o    │   │
│  │ setor {{departamento}}. Em instantes...             │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  Comando para reabrir menu    [____0____]                   │
│  ☑ Enviar menu apenas na primeira mensagem                  │
└─────────────────────────────────────────────────────────────┘
```

**Campos:**

| Campo API | Tipo | Rótulo |
|-----------|------|--------|
| `enabled` | Switch | Ativar Chatbot de Triagem |
| `welcomeMessage` | Textarea | Mensagem de boas-vindas |
| `invalidOptionMessage` | Textarea | Mensagem quando o cliente digita opção errada |
| `confirmSelectionMessage` | Textarea | Mensagem de confirmação (use `{{departamento}}`) |
| `reopenMenuCommand` | Input | Comando para reabrir menu (ex: "0") |
| `sendOnlyFirstTime` | Checkbox | Enviar menu apenas na primeira mensagem |

---

### SEÇÃO 2 — Escolhas do menu (opções do chatbot)

```
┌─────────────────────────────────────────────────────────────┐
│  Escolhas que o cliente verá no WhatsApp                    │
│  (O que aparece quando alguém manda a primeira mensagem)    │
│                                                             │
│  ┌──────────┬───────────────────────┬──────────────────┐   │
│  │ Nº       │ O que o cliente vê    │ Setor que recebe │   │
│  ├──────────┼───────────────────────┼──────────────────┤   │
│  │  1       │ Atendimento           │ [Dropdown ▾]     │   │
│  │  2       │ Vendas                │ [Dropdown ▾]     │   │
│  │  3       │ Financeiro            │ [Dropdown ▾]     │   │
│  └──────────┴───────────────────────┴──────────────────┘   │
│  ☐ Opção desativada (não aparece no menu)                   │
│                                                             │
│  [+ Adicionar nova escolha]                                 │
└─────────────────────────────────────────────────────────────┘
```

**Cada linha da tabela:**

| Campo API | Tipo | Rótulo |
|-----------|------|--------|
| `key` | Input | Nº da opção (ex: 1, 2, 3) |
| `label` | Input | O que o cliente vê (ex: "Atendimento") |
| `departamento_id` | Select | Setor que recebe a conversa (populado com GET /api/dashboard/departamentos) |
| `active` | Checkbox | Opção ativa (mostrar no menu) |

**Validações:**
- `enabled = true` exige pelo menos 1 opção com `departamento_id` válido
- `key` deve ser único entre as opções
- `label` e `departamento_id` são obrigatórios em cada linha

---

### SEÇÃO 3 — Mensagem ao finalizar atendimento

```
┌────────────────────────────────────────────────────────────────┐
│  Mensagem ao finalizar atendimento                              │
├────────────────────────────────────────────────────────────────┤
│  [ ] Enviar mensagem automaticamente quando finalizar conversa  │
│  (Switch ligado a enviarMensagemFinalizacao)                    │
│                                                                │
│  Mensagem (use {{protocolo}} e {{nome_atendente}}):             │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ Atendimento finalizado com sucesso. (Segue seu protocolo:  │ │
│  │ {{protocolo}}. Por favor, informe uma nota entre 0 e 10    │ │
│  │ para avaliar o atendimento prestado.)                      │ │
│  └────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────┘
```

**Campos:**

| Campo API | Tipo | Rótulo |
|-----------|------|--------|
| `enviarMensagemFinalizacao` | Switch | Enviar mensagem automaticamente quando finalizar conversa |
| `mensagemFinalizacao` | Textarea | Mensagem de finalização (use `{{protocolo}}` e `{{nome_atendente}}`) |

**Comportamento:** Quando o atendente clicar em "Finalizar conversa", o backend envia automaticamente essa mensagem ao cliente. Se o cliente responder com número de 0 a 10, a nota é registrada.

---

### SEÇÃO 4 — Mensagem fora do horário comercial

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Mensagem fora do horário comercial                                         │
├─────────────────────────────────────────────────────────────────────────────┤
│  [ ] Enviar mensagem automática quando o cliente escrever fora do horário   │
│  (Switch ligado a foraHorarioEnabled)                                        │
│                                                                             │
│  Horário de atendimento                                                     │
│  Início: [09:00]    Término: [18:00]                                        │
│  (inputs type="time" ou pares HH:mm)                                        │
│  Dica: horários que atravessam meia-noite são suportados (ex: 22:00–06:00). │
│                                                                             │
│  Dias em que não trabalha                                                   │
│  [ ] Dom  [ ] Seg  [ ] Ter  [ ] Qua  [ ] Qui  [ ] Sex  [ ] Sáb             │
│  (Marcado = não trabalha. Padrão: Dom e Sáb marcados)                       │
│                                                                             │
│  Datas específicas fechadas (feriados, recesso)                             │
│  [+ Adicionar data]                                                         │
│  • 25/12/2025  [Remover]                                                    │
│  • 01/01/2026  [Remover]                                                    │
│  (date picker, armazenar em YYYY-MM-DD)                                     │
│                                                                             │
│  Mensagem enviada fora do horário:                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ Olá! Nosso horário de atendimento é de segunda a sexta,              │   │
│  │ das 09h às 18h. Sua mensagem foi recebida e retornaremos            │   │
│  │ no próximo dia útil. Obrigado!                                     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Campos:**

| Campo API | Tipo | Rótulo |
|-----------|------|--------|
| `foraHorarioEnabled` | Switch | Enviar mensagem fora do horário |
| `horarioInicio` | Input time (HH:mm) | Horário de início |
| `horarioFim` | Input time (HH:mm) | Horário de término |
| `diasSemanaDesativados` | Number[] — 7 checkboxes | Dias em que não trabalha (0=Dom, 1=Seg, ..., 6=Sáb) |
| `datasEspecificasFechadas` | String[] — date picker + lista | Datas específicas fechadas (YYYY-MM-DD) |
| `mensagemForaHorario` | Textarea | Mensagem enviada fora do horário |

**Validações:**
- `mensagemForaHorario` obrigatório quando `foraHorarioEnabled = true`
- Quando `foraHorarioEnabled = false`, campos ficam desabilitados (grayed out) ou editáveis para pré-configuração

**Comportamento:**
- Dentro do horário → cliente recebe o menu de boas-vindas (triagem normal)
- Fora do horário OU dia desativado OU data fechada → cliente recebe apenas `mensagemForaHorario` (sem menu, sem departamento)

---

### SEÇÃO 5 — Configurações avançadas

```
┌─────────────────────────────────────────────────────────────┐
│  Configurações avançadas                                     │
│                                                             │
│  Como a conversa chega ao setor                             │
│  [Dropdown: Todos do setor veem ▾]                          │
│                                                             │
│  Intervalo entre envios (segundos)   [3]                    │
└─────────────────────────────────────────────────────────────┘
```

**Campos:**

| Campo API | Tipo | Rótulo | Opções |
|-----------|------|--------|--------|
| `tipo_distribuicao` | Select | Como a conversa chega ao setor | `fila` = Todos do setor veem (recomendado) · `round_robin` = Rotação automática · `menor_carga` = Menor carga |
| `intervaloEnvioSegundos` | Input number (0–60) | Intervalo entre envios (segundos) | Padrão: 3 |

---

### SEÇÃO 6 — Botão salvar + Logs

```
┌─────────────────────────────────────────────────────────────┐
│                   [Salvar configuração]                     │
├─────────────────────────────────────────────────────────────┤
│  Logs recentes                              [Atualizar]     │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 06/03 14:32 - menu_enviado - conv #123               │   │
│  │ 06/03 14:35 - opcao_valida - Atendimento (conv #123) │   │
│  │ 19/03 22:10 - fora_horario - conv #456               │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

## FLUXO DE DADOS

1. **Ao abrir a página:**
   - `GET /api/ia/config` → preencher todos os campos com `chatbot_triage`
   - `GET /api/dashboard/departamentos` → popular dropdowns de setor nas opções do menu

2. **Ao salvar:**
   ```json
   PUT /api/ia/config
   {
     "chatbot_triage": {
       "enabled": true,
       "welcomeMessage": "Olá! ...",
       "invalidOptionMessage": "Opção inválida...",
       "confirmSelectionMessage": "Perfeito! Seu atendimento foi direcionado para o setor {{departamento}}...",
       "reopenMenuCommand": "0",
       "sendOnlyFirstTime": true,
       "tipo_distribuicao": "fila",
       "intervaloEnvioSegundos": 3,
       "options": [
         { "key": "1", "label": "Atendimento", "departamento_id": 1, "active": true },
         { "key": "2", "label": "Vendas", "departamento_id": 2, "active": true }
       ],
       "enviarMensagemFinalizacao": true,
       "mensagemFinalizacao": "Atendimento finalizado. Protocolo: {{protocolo}}.",
       "foraHorarioEnabled": true,
       "horarioInicio": "09:00",
       "horarioFim": "18:00",
       "diasSemanaDesativados": [0, 6],
       "datasEspecificasFechadas": ["2025-12-25", "2026-01-01"],
       "mensagemForaHorario": "Olá! Nosso horário é de segunda a sexta, das 09h às 18h..."
     }
   }
   ```

3. **Logs:** `GET /api/ia/logs?limit=50` (botão "Atualizar" ou polling opcional)

---

## REMOVER: Aba "Bot global"

**Excluir completamente a aba/seção "Bot global" da navegação.** Ela não existe mais. Todos os recursos estão dentro de "Chatbot de Triagem".

Qualquer referência a:
- `bot_global`
- "Bot global" (tab, menu, link)
- `mensagem_boas_vindas`, `mensagem_inicial_automatica`, `mensagem_ausencia`, `mensagem_encerramento`, `tempo_limite_sem_resposta_min` do bot_global

...deve ser removida do frontend. Esses campos foram substituídos pelos campos do `chatbot_triage`.

---

## TABS DA PÁGINA (após a mudança)

A navegação da página de IA/Chatbot deve ficar assim:

```
[ Chatbot de Triagem ] [ Respostas automáticas ] [ IA (sugestões) ] [ Automações ] [ Logs do bot ]
```

A aba "Bot global" é removida.

---

## CHECKLIST DE IMPLEMENTAÇÃO

### Remoção
- [ ] Remover aba "Bot global" da navegação
- [ ] Remover componente/página do Bot global
- [ ] Remover qualquer referência a `bot_global` no código frontend

### Seção 1 — Boas-vindas
- [ ] Toggle ativar/desativar chatbot (`enabled`)
- [ ] Textarea mensagem de boas-vindas (`welcomeMessage`)
- [ ] Textarea opção inválida (`invalidOptionMessage`)
- [ ] Textarea confirmação com placeholder `{{departamento}}` (`confirmSelectionMessage`)
- [ ] Input comando reabrir menu (`reopenMenuCommand`)
- [ ] Checkbox enviar só primeira vez (`sendOnlyFirstTime`)

### Seção 2 — Opções do menu
- [ ] Tabela dinâmica: adicionar, editar, remover linhas
- [ ] Campo `key` (número único)
- [ ] Campo `label` (texto)
- [ ] Select `departamento_id` populado com GET /dashboard/departamentos
- [ ] Checkbox `active` por opção
- [ ] Validação: enabled=true exige ≥1 opção com departamento_id

### Seção 3 — Finalização
- [ ] Switch `enviarMensagemFinalizacao`
- [ ] Textarea `mensagemFinalizacao` com ajuda sobre `{{protocolo}}` e `{{nome_atendente}}`

### Seção 4 — Fora do horário
- [ ] Switch `foraHorarioEnabled`
- [ ] Input time `horarioInicio` (HH:mm)
- [ ] Input time `horarioFim` (HH:mm)
- [ ] 7 checkboxes `diasSemanaDesativados` (Dom=0 … Sáb=6)
- [ ] Lista `datasEspecificasFechadas` com date picker e botão "Remover"
- [ ] Textarea `mensagemForaHorario` (obrigatório se foraHorarioEnabled=true)
- [ ] Campos ficam disabled/acinzentados quando foraHorarioEnabled=false

### Seção 5 — Avançado
- [ ] Select `tipo_distribuicao` (fila / round_robin / menor_carga)
- [ ] Input number `intervaloEnvioSegundos` (0–60)

### Seção 6 — Salvar + Logs
- [ ] Botão "Salvar configuração" → PUT /api/ia/config
- [ ] Feedback de sucesso/erro após salvar
- [ ] Lista de logs (GET /api/ia/logs) com botão "Atualizar"

---

## RÓTULOS RECOMENDADOS

| Campo técnico | Rótulo na tela |
|---------------|----------------|
| `enabled` | Ativar Chatbot de Triagem |
| `welcomeMessage` | Mensagem de boas-vindas |
| `invalidOptionMessage` | Mensagem quando o cliente digita opção errada |
| `confirmSelectionMessage` | Mensagem de confirmação |
| `reopenMenuCommand` | Comando para ver o menu de novo |
| `sendOnlyFirstTime` | Enviar menu apenas na primeira mensagem |
| `options` | Escolhas que o cliente verá no WhatsApp |
| `key` | Nº da opção (1, 2, 3…) |
| `label` | O que o cliente vê |
| `departamento_id` | Setor que recebe a conversa |
| `active` | Opção ativa |
| `enviarMensagemFinalizacao` | Enviar mensagem ao finalizar atendimento |
| `mensagemFinalizacao` | Mensagem de finalização |
| `foraHorarioEnabled` | Enviar mensagem fora do horário |
| `horarioInicio` | Horário de início |
| `horarioFim` | Horário de término |
| `diasSemanaDesativados` | Dias em que não trabalha |
| `datasEspecificasFechadas` | Datas específicas fechadas (feriados) |
| `mensagemForaHorario` | Mensagem enviada fora do horário |
| `tipo_distribuicao` fila | Todos do setor veem — quem assumir primeiro atende |
| `tipo_distribuicao` round_robin | Rotação automática entre atendentes |
| `tipo_distribuicao` menor_carga | Atribuir ao atendente com menos conversas |
| `intervaloEnvioSegundos` | Intervalo entre envios (segundos) |
