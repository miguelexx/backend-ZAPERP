# Prompt Frontend — Mensagem Fora do Horário Comercial

Use este prompt para implementar a seção completa de **Mensagem fora do horário** na página do Chatbot de Triagem.

**Integração:** UltraMSG (webhook `/webhooks/ultramsg`). O backend processa automaticamente e envia a mensagem configurada quando o cliente envia mensagem fora do horário comercial.

---

## Objetivo

Quando um cliente envia mensagem no WhatsApp **fora do horário de funcionamento da empresa**, o chatbot envia uma mensagem personalizada informando o horário de atendimento, em vez do menu de triagem. A conversa permanece aberta (sem departamento) até que o cliente escreva novamente dentro do horário.

**Exemplo de fluxo:**
- Horário configurado: 09:00 às 18:00
- Cliente envia "Olá" às 22h → recebe a mensagem fora do horário
- Cliente envia "Olá" às 10h (dia útil) → recebe o menu de boas-vindas normalmente

---

## Campos na página do chatbot

Adicionar uma **nova seção** na página de configuração do chatbot, visível e expansível:

### Campos obrigatórios

| Campo (API) | Tipo | Rótulo sugerido | Descrição |
|-------------|------|-----------------|-----------|
| `foraHorarioEnabled` | Boolean (Switch) | **Enviar mensagem fora do horário** | Ao ativar, clientes que enviarem mensagem fora do horário ou em dias de folga receberão a mensagem em vez do menu de triagem |
| `horarioInicio` | String (time) | **Horário de início** | Hora em que o atendimento começa (formato HH:mm, ex: 09:00) |
| `horarioFim` | String (time) | **Horário de término** | Hora em que o atendimento termina (formato HH:mm, ex: 18:00) |
| `diasSemanaDesativados` | Number[] | **Dias em que não trabalha** | Dias da semana fechados: 0=domingo, 1=segunda, ..., 6=sábado. Ex: [0, 6] = fim de semana |
| `datasEspecificasFechadas` | String[] | **Datas específicas fechadas** | Feriados e recessos (formato YYYY-MM-DD). Ex: ["2025-12-25", "2026-01-01"] |
| `mensagemForaHorario` | String (Textarea) | **Mensagem para fora do horário** | Texto enviado ao cliente quando ele escreve fora do horário ou em dia de folga |

### Regras de validação

- `horarioInicio` e `horarioFim`: formato `HH:mm` (ex: 09:00, 18:30). Aceita horário que atravessa meia-noite (ex: 22:00 a 06:00).
- `diasSemanaDesativados`: array de números 0–6. Valores inválidos são ignorados. Padrão: [0, 6] (sábado e domingo).
- `datasEspecificasFechadas`: array de strings YYYY-MM-DD. Apenas datas válidas são aceitas.
- `mensagemForaHorario`: obrigatório quando `foraHorarioEnabled` for `true`. Máximo sugerido: 1024 caracteres (limite WhatsApp).
- Quando `foraHorarioEnabled` for `false`, os demais campos podem ficar desabilitados (grayed out) ou visíveis para pré-configuração.

---

## API

### GET /api/ia/config

Retorna `chatbot_triage` com os novos campos:

```json
{
  "chatbot_triage": {
    "enabled": true,
    "welcomeMessage": "...",
    "foraHorarioEnabled": false,
    "horarioInicio": "09:00",
    "horarioFim": "18:00",
    "diasSemanaDesativados": [0, 6],
    "datasEspecificasFechadas": [],
    "mensagemForaHorario": "Olá! Nosso horário de atendimento é de segunda a sexta, das 09h às 18h. Sua mensagem foi recebida e retornaremos no próximo dia útil. Obrigado!",
    ...
  }
}
```

### PUT /api/ia/config

Para salvar, enviar no body (merge — pode enviar apenas os campos alterados):

```json
{
  "chatbot_triage": {
    "foraHorarioEnabled": true,
    "horarioInicio": "08:30",
    "horarioFim": "17:30",
    "diasSemanaDesativados": [0, 6],
    "datasEspecificasFechadas": ["2025-12-25", "2026-01-01"],
    "mensagemForaHorario": "Olá! Nosso atendimento funciona de segunda a sexta, das 08h30 às 17h30. Sua mensagem foi registrada. Retornaremos em breve!"
  }
}
```

---

## Layout sugerido (UI)

### Seção expansível / card

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  📅 Mensagem fora do horário comercial                    [▼ Expandir]     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  [ ] Enviar mensagem automática quando o cliente escrever fora do horário   │
│      (Switch ligado a foraHorarioEnabled)                                    │
│                                                                             │
│  ┌─ Horário de atendimento ────────────────────────────────────────────────┐ │
│  │                                                                         │ │
│  │  Início:  [ 09  ] : [ 00  ]     Término:  [ 18  ] : [ 00  ]            │ │
│  │           (horarioInicio)                 (horarioFim)                  │ │
│  │                                                                         │ │
│  │  Dica: Use 24 horas. Ex: 09:00, 13:30, 18:00.                           │ │
│  │  Horários que atravessam meia-noite (ex: 22:00 a 06:00) são suportados. │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│  ┌─ Dias da semana em que não trabalha ───────────────────────────────────┐ │
│  │                                                                         │ │
│  │  [ ] Dom  [ ] Seg  [ ] Ter  [ ] Qua  [ ] Qui  [ ] Sex  [ ] Sáb          │ │
│  │  (Checkboxes: 0=Dom, 1=Seg, ..., 6=Sáb. Marcar = dia desativado)       │ │
│  │  Padrão: Sábado e Domingo marcados (diasSemanaDesativados: [0, 6])     │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│  ┌─ Datas específicas fechadas (feriados, recesso) ───────────────────────┐ │
│  │                                                                         │ │
│  │  [+ Adicionar data]                                                     │ │
│  │                                                                         │ │
│  │  • 25/12/2025 (Natal)                              [Remover]            │ │
│  │  • 01/01/2026 (Ano Novo)                           [Remover]            │ │
│  │                                                                         │ │
│  │  (Lista de datas YYYY-MM-DD; usar date picker para adicionar)           │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│  Mensagem enviada fora do horário:                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ Olá! Nosso horário de atendimento é de segunda a sexta,              │   │
│  │ das 09h às 18h. Sua mensagem foi recebida e retornaremos            │   │
│  │ no próximo dia útil. Obrigado!                                     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│  (Textarea, 4–6 linhas, placeholder com exemplo)                            │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Componentes de horário

**Opção A — Inputs separados (recomendado):**
- Dois pares de inputs numéricos: `[HH] : [mm]` para início e fim
- Validação: 0–23 horas, 0–59 minutos
- Formatado ao salvar como "HH:mm" (ex: 09:00, 18:30)

**Opção B — Input type="time":**
- `<input type="time" />` nativo do HTML5
- Valor no formato "HH:mm" — compatível direto com a API

**Opção C — Select de horas:**
- Select com opções pré-definidas (08:00, 08:30, 09:00 … 18:00, 18:30, 19:00)

### Dias da semana (`diasSemanaDesativados`)

**Implementação recomendada:** 7 checkboxes lado a lado — Dom, Seg, Ter, Qua, Qui, Sex, Sáb.

- **Marcado** = dia em que a empresa **não trabalha** (cliente recebe mensagem fora do horário).
- **Desmarcado** = dia útil (respeita apenas horário início/fim).
- Mapeamento: Dom=0, Seg=1, Ter=2, Qua=3, Qui=4, Sex=5, Sáb=6.
- Ao salvar: enviar array com os números dos dias marcados. Ex: [0, 6] = fim de semana.

### Calendário / Datas específicas (`datasEspecificasFechadas`)

**Implementação recomendada:** Lista de datas com botão "Adicionar data".

- **Date picker** (input type="date" ou componente de calendário) para selecionar a data.
- Armazenar no formato **YYYY-MM-DD** (ex: "2025-12-25").
- Lista exibida com data formatada (ex: 25/12/2025) e botão "Remover".
- Feriados comuns: Natal (25/12), Ano Novo (01/01), etc.
- Pode oferecer "Adicionar feriados do Brasil" como atalho (opcional).

### Estado quando desativado

Quando `foraHorarioEnabled` for `false`:
- Campos de horário e mensagem podem ficar desabilitados (readonly/disabled) e acinzentados
- Ou permanecer editáveis para o usuário já deixar tudo configurado antes de ativar

---

## Comportamento

1. **Dentro do horário e dia útil:** Cliente envia mensagem → recebe o menu de boas-vindas (triagem normal).
2. **Fora do horário OU em dia desativado OU em data fechada:** Cliente envia mensagem → recebe apenas `mensagemForaHorario`. Não recebe o menu. A conversa não é direcionada a nenhum departamento.
3. **Dias da semana:** Configurar em `diasSemanaDesativados` quais dias não trabalha (ex: [0, 6] = sábado e domingo).
4. **Datas específicas:** Feriados e recessos em `datasEspecificasFechadas` (formato YYYY-MM-DD).
5. **Horário que atravessa meia-noite:** Ex.: 22:00 a 06:00 — considera "dentro" entre 22h e 06h.
6. **Logs:** O backend registra `fora_horario` em `bot_logs` com `horario_inicio`, `horario_fim` e `dias_semana_desativados`.

---

## Exemplo de mensagem padrão

```
Olá! Nosso horário de atendimento é de segunda a sexta, das 09h às 18h. Sua mensagem foi recebida e retornaremos no próximo dia útil. Obrigado!
```

### Sugestões de personalização

| Contexto | Exemplo de mensagem |
|----------|---------------------|
| Comércio | "Olá! Estamos fechados no momento. Nosso horário é de 9h às 18h, de segunda a sábado. Deixe sua mensagem que responderemos assim que abrirmos!" |
| Serviços | "Obrigado pelo contato. Nosso atendimento funciona das 8h às 17h, de segunda a sexta. Sua solicitação foi registrada e entraremos em contato." |
| Suporte | "Recebemos sua mensagem. Nosso suporte está disponível de 8h às 18h. Responderemos no próximo horário de atendimento." |

---

## Checklist de implementação

- [ ] Seção "Mensagem fora do horário comercial" na página do chatbot
- [ ] Switch "Enviar mensagem fora do horário" ligado a `foraHorarioEnabled`
- [ ] Campo "Horário de início" (`horarioInicio`) — formato HH:mm
- [ ] Campo "Horário de término" (`horarioFim`) — formato HH:mm
- [ ] **Dias da semana:** Checkboxes ou toggles para `diasSemanaDesativados` (0–6)
- [ ] **Calendário/datas:** Lista de `datasEspecificasFechadas` com date picker e botão "Adicionar data"
- [ ] Textarea "Mensagem fora do horário" ligado a `mensagemForaHorario`
- [ ] Validação: `mensagemForaHorario` obrigatório quando `foraHorarioEnabled` = true
- [ ] Carregar valores via GET /api/ia/config
- [ ] Salvar via PUT /api/ia/config (enviar `chatbot_triage` com os novos campos)
- [ ] (Opcional) Preview da mensagem e do horário configurado
- [ ] (Opcional) Atalho "Adicionar feriados comuns" (Natal, Ano Novo, etc.)

---

## Integração com outros blocos

Esta seção deve ficar **junto** às demais configurações do chatbot (welcomeMessage, mensagem de finalização, opções do menu). Ordem sugerida na página:

1. Ativar chatbot + Mensagem de boas-vindas
2. Opções do menu (setores)
3. Mensagens de confirmação e opção inválida
4. Mensagem ao finalizar atendimento
5. **Mensagem fora do horário** (esta seção)
6. Configurações avançadas (intervalo, distribuição, etc.)

---

## Tipos de log do bot

O tipo `fora_horario` passa a aparecer nos logs (`GET /api/ia/logs`). O frontend pode exibir uma indicação visual quando o chatbot responder por estar fora do horário.
