# Prompt Frontend — Encerramento automático por inatividade (Automações)

> **Objetivo:** Adicionar na aba **Automações** o campo para configurar a **mensagem** enviada quando a conversa é encerrada automaticamente por inatividade do cliente ao chatbot. O tempo (minutos) já existe; a lógica foi ajustada no backend para encerrar **somente** quando o cliente não responde ao chatbot, com exceção para a mensagem de "fora do horário".

---

## O QUE MUDOU NO BACKEND

1. **Novo campo:** `automacoes.mensagem_encerramento_inatividade`
   - Mensagem enviada ao cliente quando a conversa é encerrada por inatividade.
   - Exemplo padrão: `-conversa encerrada por conta de inatividade-`

2. **Lógica de encerramento (somente por inatividade):**
   - O chatbot enviou mensagem ao cliente.
   - O cliente **não respondeu** dentro do tempo configurado (`encerrar_automatico_min`).
   - O sistema envia a mensagem configurada e fecha a conversa.

3. **Exceção — mensagem fora do horário:**
   - Quando o cliente manda mensagem **fora do horário** e o chatbot envia "Nosso horário de atendimento é..." (configurado em `chatbot_triage.mensagemForaHorario`), a conversa **não** será encerrada automaticamente, mesmo que o cliente não responda. Permanece aberta para o humano atender no próximo dia útil.

---

## O QUE O FRONTEND DEVE FAZER

### Na aba **Automações**, na seção de encerramento automático:

1. **Manter** o campo existente:
   - Label: `Encerrar conversa automaticamente após X minutos (0 = desativado)`
   - API: `automacoes.encerrar_automatico_min`
   - Tipo: input number

2. **Adicionar** o novo campo (visível apenas quando `encerrar_automatico_min > 0`):
   - Label: `Mensagem ao encerrar por inatividade`
   - API: `automacoes.mensagem_encerramento_inatividade`
   - Tipo: textarea
   - Placeholder ou valor padrão: `-conversa encerrada por conta de inatividade-`
   - Texto de ajuda: *"Enviada ao cliente quando a conversa é fechada automaticamente por não ter respondido ao chatbot dentro do tempo configurado. Exceção: não encerra quando a última mensagem do bot foi a de fora do horário."*

### Exemplo de UI:

```
┌─────────────────────────────────────────────────────────────┐
│  5. Automações                                              │
│  Comportamentos automáticos do sistema                      │
│                                                             │
│  Encerrar conversa automaticamente após X minutos           │
│  (0 = desativado)                                           │
│  [  15  ]                                                   │
│                                                             │
│  Mensagem ao encerrar por inatividade                       │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ -conversa encerrada por conta de inatividade-        │   │
│  └─────────────────────────────────────────────────────┘   │
│  (Enviada quando o cliente não responde ao chatbot         │
│   dentro do tempo. Não encerra se a última msg foi         │
│   a de fora do horário.)                                    │
│                                                             │
│  [ ] Transferir para humano após bot                        │
│  Limite de mensagens do bot  [ 10 ]                         │
│  ...                                                        │
│                                                             │
│  [ Salvar ]                                                 │
└─────────────────────────────────────────────────────────────┘
```

### Salvamento (PUT /api/ia/config):

```json
{
  "automacoes": {
    "encerrar_automatico_min": 15,
    "mensagem_encerramento_inatividade": "-conversa encerrada por conta de inatividade-",
    "transferir_para_humano_apos_bot": true,
    "limite_mensagens_bot": 10,
    "auto_assumir": false,
    "reabrir_automaticamente": true
  }
}
```

---

## JOB DE CRON (operacional)

O backend expõe o endpoint:

```
POST /jobs/timeout-inatividade-chatbot
Header: X-Cron-Secret: <CRON_SECRET do .env>
```

Deve ser chamado periodicamente por um cron externo (ex.: a cada 5 ou 10 minutos), junto com `/jobs/timeout-inatividade` (inatividade do atendente humano).
