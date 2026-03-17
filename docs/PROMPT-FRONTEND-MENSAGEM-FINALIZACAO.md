# Prompt Frontend — Mensagem de Finalização e Avaliação

Use este prompt ao adicionar o campo de configuração da mensagem de finalização na página do chatbot de triagem.

**Integração:** UltraMSG (webhook `/webhooks/ultramsg` → processamento unificado). A captura da nota 0-10 e o registro do atendente que atendeu são feitos automaticamente.

---

## Objetivo

Permitir que o usuário configure uma mensagem que será enviada **automaticamente** ao cliente quando ele clicar em "Finalizar conversa". A mensagem pode incluir:
- Protocolo do atendimento
- Solicitação de avaliação (nota 0-10)

O cliente que responder com um número de 0 a 10 terá sua nota registrada e a IA do sistema poderá informar a média das notas quando o usuário perguntar.

---

## Campos na página do chatbot

Adicionar na seção de configuração do chatbot (junto a welcomeMessage, confirmSelectionMessage etc.):

| Campo | Tipo | Descrição |
|-------|------|-----------|
| **Enviar mensagem ao finalizar** | Checkbox/Switch | `enviarMensagemFinalizacao` — ao ativar, a mensagem configurada abaixo é enviada automaticamente quando o atendente clicar em "Finalizar conversa" |
| **Mensagem de finalização** | Textarea | `mensagemFinalizacao` — template com placeholders opcionais |

### Placeholders na mensagem

| Placeholder | Substituição |
|-------------|--------------|
| `{{protocolo}}` | Número do protocolo (ID do atendimento) |
| `{{nome_atendente}}` | Nome do atendente que finalizou |

### Exemplo de mensagem padrão

```
Atendimento finalizado com sucesso. (Segue seu protocolo: {{protocolo}}.
Por favor, informe uma nota entre 0 e 10 para avaliar o atendimento prestado.)
```

---

## API

### GET /api/ia/config

Retorna `chatbot_triage` com os novos campos:

```json
{
  "chatbot_triage": {
    "enabled": true,
    "welcomeMessage": "...",
    "enviarMensagemFinalizacao": false,
    "mensagemFinalizacao": "Atendimento finalizado com sucesso. (Segue seu protocolo: {{protocolo}}.\nPor favor, informe uma nota entre 0 e 10 para avaliar o atendimento prestado.)",
    ...
  }
}
```

### PUT /api/ia/config

Para salvar, enviar no body:

```json
{
  "chatbot_triage": {
    "enviarMensagemFinalizacao": true,
    "mensagemFinalizacao": "Sua mensagem customizada aqui. Protocolo: {{protocolo}}."
  }
}
```

O backend faz merge — pode enviar só os campos alterados.

---

## Comportamento

1. **Ao finalizar:** Se `enviarMensagemFinalizacao` estiver ativo e `mensagemFinalizacao` não estiver vazia, o backend envia a mensagem automaticamente ao cliente (substituindo `{{protocolo}}` e `{{nome_atendente}}`).
2. **Cliente responde 0-10:** O sistema (via webhook UltraMSG) detecta e armazena a nota em `avaliacoes_atendimento`, **registrando o atendente que atendeu** (`atendente_id` = quem encerrou a conversa). Uma nota por atendimento.
3. **IA:** O assistente conhece `notasAtendimento` (média geral, total, distribuição, **por atendente**). Perguntas como "qual a média das notas?" ou "qual atendente tem melhor avaliação?" são respondidas com os dados.

---

## Layout sugerido (UI)

```
┌────────────────────────────────────────────────────────────────┐
│  Mensagem ao finalizar atendimento                              │
├────────────────────────────────────────────────────────────────┤
│  [ ] Enviar mensagem automaticamente quando finalizar conversa  │
│                                                                │
│  Mensagem (use {{protocolo}} e {{nome_atendente}}):             │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ Atendimento finalizado com sucesso. (Segue seu protocolo:  │ │
│  │ {{protocolo}}. Por favor, informe uma nota entre 0 e 10    │ │
│  │ para avaliar o atendimento prestado.)                      │ │
│  └────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────┘
```

---

## Checklist

- [ ] Checkbox "Enviar mensagem ao finalizar" ligado a `enviarMensagemFinalizacao`
- [ ] Textarea "Mensagem de finalização" ligado a `mensagemFinalizacao`
- [ ] Texto de ajuda sobre placeholders (`{{protocolo}}`, `{{nome_atendente}}`)
- [ ] Carregar e salvar via GET/PUT /api/ia/config
- [ ] (Opcional) Preview da mensagem com exemplo de protocolo
