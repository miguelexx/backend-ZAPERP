# Página de Chatbot — Especificação para Frontend

> ZapERP usa **apenas Z-API**. O chatbot de triagem funciona via webhook Z-API.

## Rótulos sugeridos para a interface (linguagem simples)

Use estes textos na tela para facilitar o entendimento de leigos:

| Termo técnico | Rótulo sugerido na tela |
|---------------|-------------------------|
| Opções do menu | **Escolhas que o cliente verá no WhatsApp** |
| Key | **Nº da opção** (ex: 1, 2, 3) |
| Label | **Texto que o cliente vê** ou **Nome da opção** |
| Departamento | **Setor que vai receber a conversa** |
| Ativo | **Opção ativa** ou **Mostrar esta opção no menu** |
| Adicionar opção | **Adicionar nova escolha** |
| Remover | **Remover esta opção** |
| Distribuição | **Como a conversa chega ao setor** |

**Dica:** Pode usar um texto de ajuda (tooltip) em cada campo, por exemplo: *"O número que o cliente digita para escolher (1, 2, 3...)"* ao lado de "Nº da opção".

### PROMPT: Campo "Distribuição" (tipo_distribuicao)

**Rótulo na tela:** "Como a conversa chega ao setor" ou "Quando o cliente escolhe o setor"

**Tooltip:** *"Define o que acontece quando o cliente responde com o número do setor (ex: 1 para Vendas)."*

| Valor (API) | Rótulo para o usuário |
|-------------|------------------------|
| `fila` | **Todos do setor veem** — A conversa aparece para todos. Quem clicar em "Assumir" primeiro atende. |
| `round_robin` | **Rotação automática** — O sistema escolhe um atendente do setor para receber a conversa. |
| `menor_carga` | **Menor carga** — O atendente com menos conversas ativas recebe automaticamente. |

**Recomendado:** Use `fila` como padrão. O sistema apenas define o setor e todos os usuários daquele setor veem a conversa. Quem puder assume primeiro.

```js
// Exemplo para o frontend
const tipoDistribuicaoOptions = [
  { value: 'fila', label: 'Todos do setor veem — quem assumir primeiro atende' },
  { value: 'round_robin', label: 'Rotação automática entre atendentes do setor' },
  { value: 'menor_carga', label: 'Atribuir ao atendente com menos conversas' },
]
```

---

## 1. Visão geral

A página de Chatbot permite configurar o **roteador automático de atendimento**:
- Mensagem de boas-vindas
- Menu de setores (opções numéricas)
- Vinculação automática ao departamento escolhido
- Transferência para usuários do setor

## 2. APIs do Backend

### 2.1 Buscar configuração
```
GET /api/ia/config
Authorization: Bearer <token>
```

**Resposta:**
```json
{
  "chatbot_triage": {
    "enabled": false,
    "welcomeMessage": "",
    "invalidOptionMessage": "Opção inválida. Por favor, responda apenas com o número do setor desejado.",
    "confirmSelectionMessage": "Perfeito! Seu atendimento foi direcionado para o setor {{departamento}}. Em instantes nossa equipe dará continuidade.",
    "sendOnlyFirstTime": true,
    "fallbackToAI": false,
    "businessHoursOnly": false,
    "transferMode": "departamento",
    "tipo_distribuicao": "fila",
    "reopenMenuCommand": "0",
    "options": []
  },
  "bot_global": { ... },
  "roteamento": { ... },
  "ia": { ... },
  "automacoes": { ... }
}
```

### 2.2 Salvar configuração
```
PUT /api/ia/config
Authorization: Bearer <token>
Content-Type: application/json

{
  "chatbot_triage": {
    "enabled": true,
    "welcomeMessage": "Olá! Seja bem-vindo(a) à Empresa X.\nPara direcionarmos seu atendimento, escolha o setor:\n\n1 - Atendimento\n2 - Vendas\n3 - Financeiro\n\nResponda com o número da opção desejada.",
    "invalidOptionMessage": "Opção inválida. Por favor, responda apenas com o número do setor desejado.",
    "confirmSelectionMessage": "Perfeito! Seu atendimento foi direcionado para o setor {{departamento}}. Em instantes nossa equipe dará continuidade.",
    "sendOnlyFirstTime": true,
    "tipo_distribuicao": "fila",
    "reopenMenuCommand": "0",
    "options": [
      { "key": "1", "label": "Atendimento", "departamento_id": 1, "active": true },
      { "key": "2", "label": "Vendas", "departamento_id": 2, "active": true }
    ]
  }
}
```

### 2.3 Listar departamentos (para dropdown)
```
GET /api/dashboard/departamentos
Authorization: Bearer <token>
```

**Resposta:** Array de `{ id, nome, company_id }`

### 2.4 Logs do bot
```
GET /api/ia/logs?limit=50
Authorization: Bearer <token>
```

**Resposta:** Array de `{ id, conversa_id, tipo, detalhes, criado_em }`  
Tipos: `menu_enviado`, `opcao_valida`, `opcao_invalida`, `menu_reenviado`

---

## 3. Estrutura da Página (UI)

### 3.1 Layout sugerido

```
┌─────────────────────────────────────────────────────────────┐
│  Chatbot de Triagem                              [Ativar]   │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Mensagem de boas-vindas                                    │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Olá! Seja bem-vindo(a)...                           │   │
│  │ 1 - Atendimento                                     │   │
│  │ 2 - Vendas                                          │   │
│  │ Responda com o número da opção desejada.            │   │
│  └─────────────────────────────────────────────────────┘   │
│  (textarea, 4-6 linhas)                                     │
│                                                             │
│  Mensagem de opção inválida                                 │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Opção inválida. Por favor, responda apenas...       │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  Mensagem de confirmação (use {{departamento}} para o nome)  │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Perfeito! Seu atendimento foi direcionado...         │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  Comando para reabrir menu (ex: 0)  [____0____]              │
│                                                             │
│  ☑ Enviar menu apenas na primeira mensagem                  │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│  Escolhas que o cliente verá no WhatsApp                   │
│  (O que aparece quando alguém manda a primeira mensagem)    │
│                                                             │
│  ┌────────────────┬───────────────────────┬─────────────┐   │
│  │ Nº da opção    │ O que o cliente vê    │ Setor que   │   │
│  │ (ex: 1, 2, 3)  │ (texto no menu)       │ recebe a    │   │
│  │                │                        │ conversa    │   │
│  ├────────────────┼───────────────────────┼─────────────┤   │
│  │  1             │ Atendimento           │ [Dropdown]  │   │
│  │  2             │ Vendas                │ [Dropdown]  │   │
│  │  3             │ Financeiro            │ [Dropdown]  │   │
│  └────────────────┴───────────────────────┴─────────────┘   │
│  ☐ Opção desativada (não aparece no menu)                   │
│  [+ Adicionar nova escolha]                                 │
│                                                             │
│  [Salvar configuração]                                      │
├─────────────────────────────────────────────────────────────┤
│  Logs recentes                              [Atualizar]     │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 06/03 14:32 - menu_enviado - conv #123               │   │
│  │ 06/03 14:35 - opcao_valida - Atendimento (conv #123) │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 Explicação simples (para quem não é técnico)

**O que são as "escolhas do menu"?**

Quando um cliente manda a primeira mensagem no WhatsApp, o sistema envia um menu com opções. Exemplo:

```
1 - Atendimento
2 - Vendas
3 - Financeiro
```

Cada linha é uma **escolha** que você configura na tabela:

| Na tela você vê | O que significa |
|-----------------|----------------|
| **Nº da opção** | O número que o cliente digita ou clica (1, 2, 3...) |
| **O que o cliente vê** | O texto que aparece no menu (ex: "Atendimento", "Vendas") |
| **Setor que recebe** | Para qual equipe a conversa vai quando o cliente escolher essa opção |
| **Opção desativada** | Se marcar, essa escolha não aparece no menu (útil para desativar temporariamente) |

**Resumindo:** Você define as escolhas (ex: Atendimento, Vendas, Financeiro) e para qual setor cada uma manda o cliente. Com **"Todos do setor veem"** (fila), quem estiver naquele setor verá a conversa no painel e poderá assumir — o primeiro a clicar em "Assumir" atende.

**Importante:** Se a conversa está indo automaticamente para um usuário específico em vez de aparecer para todos do setor, verifique o campo **Distribuição** e altere para **"Todos do setor veem"** (`fila`).

### 3.3 Componentes obrigatórios (referência técnica)

| Componente | Tipo | Campo técnico |
|------------|------|---------------|
| Ligar/Desligar chatbot | Switch | `chatbot_triage.enabled` |
| Mensagem de boas-vindas | Textarea | `welcomeMessage` |
| Mensagem quando digita opção errada | Textarea | `invalidOptionMessage` |
| Mensagem de confirmação | Textarea | `confirmSelectionMessage` — use `{{departamento}}` para o nome do setor |
| Comando para ver o menu de novo | Input | `reopenMenuCommand` (ex: "0") |
| Enviar menu só na primeira vez | Checkbox | `sendOnlyFirstTime` |
| Distribuição | Select | `tipo_distribuicao`: `fila` (**recomendado** — todos do setor veem; primeiro a assumir ganha), `round_robin`, `menor_carga` |
| Tabela de escolhas | Dinâmica | key, label, departamento_id, active |
| Botão Salvar | Button | PUT /api/ia/config |
| Área de logs | Lista | GET /api/ia/logs |

### 3.4 Validações no frontend

- `enabled` = true exige pelo menos 1 opção com `departamento_id` válido
- O **número da opção** deve ser único (1, 2, 3...)
- O **texto** e o **setor** são obrigatórios em cada linha
- Ao salvar, enviar apenas `chatbot_triage` no body (ou o objeto completo conforme backend)

---

## 4. Fluxo de dados

1. **Ao carregar:** GET /ia/config + GET /dashboard/departamentos
2. **Ao salvar:** PUT /ia/config com `{ chatbot_triage: { ... } }`
3. **Logs:** GET /ia/logs (opcional, pode ter botão "Atualizar")

---

## 5. Exemplo de payload completo para salvar

```json
{
  "chatbot_triage": {
    "enabled": true,
    "welcomeMessage": "Olá! Seja bem-vindo(a) à MENDONÇA Artefatos de Cimento.\nPara direcionarmos seu atendimento, por favor escolha com qual setor deseja falar:\n\n1 - Atendimento\n2 - Vendas\n3 - Financeiro\n4 - Compras\n5 - RH\n6 - Diretoria\n\nResponda com o número da opção desejada.",
    "invalidOptionMessage": "Opção inválida. Por favor, responda apenas com o número do setor desejado.",
    "confirmSelectionMessage": "Perfeito! Seu atendimento foi direcionado para o setor {{departamento}}. Em instantes nossa equipe dará continuidade.",
    "sendOnlyFirstTime": true,
    "fallbackToAI": false,
    "businessHoursOnly": false,
    "transferMode": "departamento",
    "reopenMenuCommand": "0",
    "options": [
      { "key": "1", "label": "Atendimento", "departamento_id": 1, "active": true },
      { "key": "2", "label": "Vendas", "departamento_id": 2, "active": true },
      { "key": "3", "label": "Financeiro", "departamento_id": 3, "active": true }
    ]
  }
}
```

---

## 6. Pré-requisitos

- **Z-API conectada:** A instância deve estar conectada (empresa_zapi)
- **Departamentos cadastrados:** Criar em Configurações > Departamentos
- **Usuários vinculados:** Cada departamento deve ter usuários com `departamento_id` definido

---

## 7. Roteamento no frontend

Sugestão: `/configuracoes/chatbot` ou `/ia/chatbot` ou item no menu "Configurações" > "Chatbot de Triagem"

---

## 8. Checklist de certificação (Z-API)

| Item | Verificar |
|------|-----------|
| WHATSAPP_PROVIDER | `zapi` no .env |
| empresa_zapi | instance_id da Z-API mapeado para company_id |
| Webhook Z-API | URL configurada no painel Z-API: `APP_URL/webhooks/zapi?token=ZAPI_WEBHOOK_TOKEN` |
| Departamentos | Cadastrados em Configurações > Departamentos |
| Usuários | Vinculados a departamentos (departamento_id) |
| Chatbot ativo | enabled: true + pelo menos 1 opção com departamento_id |
| Teste ponta a ponta | Cliente envia msg → recebe menu → responde número → conversa vai para o setor |

---

## 8. Checklist de certificação (Z-API)

| Item | Verificar |
|------|-----------|
| `.env` | `WHATSAPP_PROVIDER=zapi` |
| `empresa_zapi` | Registro com `company_id`, `instance_id`, `instance_token`, `ativo=true` |
| Webhook Z-API | URL configurada no painel Z-API: `{APP_URL}/webhooks/zapi?token={ZAPI_WEBHOOK_TOKEN}` |
| Departamentos | Cadastrados em Configurações > Departamentos |
| Usuários | Vinculados a departamentos (`departamento_id`) |
| Chatbot | `enabled=true`, `options` com `departamento_id` válidos |
| Teste | Cliente envia mensagem → recebe menu → responde número → conversa vai para o setor |

---

## 8. Checklist de certificação (Z-API)

| Item | Verificação |
|------|-------------|
| WHATSAPP_PROVIDER | Deve ser `zapi` no .env |
| empresa_zapi | instance_id do Z-API deve estar cadastrado com company_id |
| Webhook Z-API | URL configurada no painel Z-API: `APP_URL/webhooks/zapi?token=ZAPI_WEBHOOK_TOKEN` |
| Departamentos | Cadastrados em Configurações > Departamentos |
| Usuários | Vinculados a departamentos (departamento_id) |
| Chatbot ativo | enabled: true + ao menos 1 opção com departamento_id |
| Teste ponta a ponta | Cliente envia msg → recebe menu → responde número → conversa vai para o setor |

---

## 8. Checklist de certificação (Z-API)

| Item | Verificação |
|------|-------------|
| WHATSAPP_PROVIDER | Deve ser `zapi` no .env |
| empresa_zapi | instance_id da Z-API deve estar cadastrado com company_id correto |
| Webhook Z-API | URL configurada no painel Z-API: `APP_URL/webhooks/zapi?token=ZAPI_WEBHOOK_TOKEN` |
| Departamentos | Cadastrados em Configurações > Departamentos |
| Usuários | Vinculados aos departamentos (departamento_id) |
| Chatbot ativo | enabled=true + pelo menos 1 opção com departamento_id |
| Teste ponta a ponta | Cliente envia msg → recebe menu → responde número → conversa vai para o setor |

---

## 8. Checklist de certificação (Z-API)

| Item | Verificação |
|------|-------------|
| WHATSAPP_PROVIDER | Deve ser `zapi` no .env |
| empresa_zapi | instance_id da Z-API deve estar cadastrado com company_id correto |
| Webhook Z-API | URL configurada no painel Z-API: `APP_URL/webhooks/zapi?token=ZAPI_WEBHOOK_TOKEN` |
| Departamentos | Cadastrados em Configurações > Departamentos |
| Usuários | Vinculados aos departamentos (departamento_id) |
| Chatbot ativo | enabled: true + ao menos 1 opção com departamento_id |
| Teste ponta a ponta | Cliente envia msg → recebe menu → responde número → conversa vai para o setor |

---

## 8. Checklist de certificação (Z-API)

| Item | Verificação |
|------|-------------|
| WHATSAPP_PROVIDER | Deve ser `zapi` no .env |
| empresa_zapi | instance_id do webhook deve existir na tabela com company_id correto |
| Webhook Z-API | URL configurada no painel Z-API: `APP_URL/webhooks/zapi?token=ZAPI_WEBHOOK_TOKEN` |
| Departamentos | Cadastrados em Configurações > Departamentos |
| Usuários | Vinculados aos departamentos (departamento_id) |
| Chatbot ativo | enabled=true + pelo menos 1 opção com departamento_id |

---

## 8. Checklist de certificação (Z-API)

| Item | Verificação |
|------|-------------|
| WHATSAPP_PROVIDER | Deve ser `zapi` no .env |
| empresa_zapi | instance_id do webhook deve existir na tabela com company_id correto |
| Webhook Z-API | URL configurada no painel Z-API: `APP_URL/webhooks/zapi?token=ZAPI_WEBHOOK_TOKEN` |
| Departamentos | Cadastrados em Configurações > Departamentos |
| Usuários | Vinculados aos departamentos (departamento_id) |
| Chatbot ativo | enabled=true + pelo menos 1 opção com departamento_id |
| Teste ponta a ponta | Cliente envia msg → recebe menu → responde número → conversa vai para o setor |

---

## 8. Checklist de certificação (Z-API apenas)

### Backend
- [ ] `WHATSAPP_PROVIDER=zapi` no .env
- [ ] `empresa_zapi` com registro ativo (company_id, instance_id, instance_token, ativo=true)
- [ ] Webhook Z-API configurado no painel: `APP_URL/webhooks/zapi` (ou `/webhook/zapi`)
- [ ] Departamento(s) cadastrados em Configurações
- [ ] Usuários vinculados aos departamentos

### Frontend (página de chatbot)
- [ ] GET /api/ia/config carrega chatbot_triage
- [ ] GET /api/dashboard/departamentos popula dropdown de setores
- [ ] PUT /api/ia/config salva chatbot_triage (pode enviar só `{ chatbot_triage: {...} }`)
- [ ] Toggle ativar/desativar
- [ ] Tabela de opções com key, label, departamento (dropdown), ativo
- [ ] Validação: enabled=true exige ≥1 opção com departamento_id
- [ ] GET /api/ia/logs exibe logs recentes (opcional)

---

## 8. Checklist de certificação (Z-API)

### Backend
- [ ] `WHATSAPP_PROVIDER=zapi` no .env
- [ ] `empresa_zapi` com registro: `company_id`, `instance_id`, `instance_token`, `client_token`, `ativo=true`
- [ ] Webhook Z-API configurado no painel: URL = `{APP_URL}/webhooks/zapi?token={ZAPI_WEBHOOK_TOKEN}`
- [ ] Departamentos cadastrados em Configurações > Departamentos
- [ ] Usuários com `departamento_id` vinculado aos setores

### Frontend (página de chatbot)
- [ ] GET /api/ia/config carrega chatbot_triage
- [ ] GET /api/dashboard/departamentos popula dropdown de opções
- [ ] PUT /api/ia/config salva com sucesso
- [ ] Toggle Ativar/Desativar funcional
- [ ] Tabela de opções: adicionar, editar, remover
- [ ] Logs exibidos (GET /api/ia/logs)

### Teste ponta a ponta
1. Ativar chatbot na página
2. Configurar mensagem de boas-vindas e opções (1=Atendimento, 2=Vendas, etc.)
3. Salvar
4. Enviar mensagem do WhatsApp para o número conectado
5. Verificar: recebe menu automático
6. Responder "1" → conversa deve ir para departamento Atendimento
7. Verificar logs em /api/ia/logs

---

## 8. Checklist de certificação (Z-API)

| Item | Verificação |
|------|-------------|
| WHATSAPP_PROVIDER | Deve ser `zapi` no .env (default do backend já é zapi) |
| empresa_zapi | instance_id da Z-API deve estar cadastrado com company_id correto |
| Webhook Z-API | URL configurada no painel Z-API: `{APP_URL}/webhooks/zapi?token={ZAPI_WEBHOOK_TOKEN}` |
| Departamentos | Cadastrados em Configurações > Departamentos |
| Usuários | Vinculados aos departamentos (departamento_id) |
| Chatbot ativo | enabled=true + pelo menos 1 opção com departamento_id |
| Teste ponta a ponta | Cliente envia msg → recebe menu → responde número → conversa vai para o setor |

---

## 8. Checklist de certificação (Z-API apenas)

### Backend
- [ ] `WHATSAPP_PROVIDER=zapi` no .env
- [ ] `empresa_zapi` com registro ativo (company_id, instance_id, instance_token, client_token)
- [ ] Webhook Z-API configurado no painel: `APP_URL/webhooks/zapi` (ou `/webhook/zapi`)
- [ ] GET /api/ia/config retorna `chatbot_triage`
- [ ] PUT /api/ia/config salva `chatbot_triage` corretamente

### Frontend
- [ ] Página carrega config e departamentos ao abrir
- [ ] Toggle ativar/desativar funciona
- [ ] Opções do menu com dropdown de departamentos
- [ ] Salvar persiste e exibe feedback de sucesso/erro
- [ ] Logs exibidos (opcional)

### Fluxo ponta a ponta
1. [ ] Cliente envia mensagem no WhatsApp → recebe menu de boas-vindas
2. [ ] Cliente responde "1" (ou número válido) → conversa vinculada ao departamento
3. [ ] Conversa aparece para usuários do departamento escolhido
4. [ ] Cliente recebe mensagem de confirmação
5. [ ] Resposta inválida → recebe mensagem de erro + menu novamente

---

## 8. Checklist de certificação (Z-API)

### Backend
- [ ] `WHATSAPP_PROVIDER=zapi` no .env (ou default já é zapi)
- [ ] `empresa_zapi` com registro: `company_id`, `instance_id`, `instance_token`, `client_token`, `ativo=true`
- [ ] Webhook Z-API configurado no painel: URL = `{APP_URL}/webhooks/zapi?token={ZAPI_WEBHOOK_TOKEN}`
- [ ] Departamentos cadastrados em Configurações > Departamentos
- [ ] Usuários com `departamento_id` vinculado aos setores

### Frontend
- [ ] Página de Chatbot acessível (ex: Configurações > Chatbot)
- [ ] GET /ia/config carrega `chatbot_triage` corretamente
- [ ] Dropdown de departamentos populado com GET /dashboard/departamentos
- [ ] PUT /ia/config salva e retorna sucesso
- [ ] Toggle Ativar/Desativar funcional
- [ ] Tabela de opções: adicionar, editar, remover linhas
- [ ] Logs exibidos (GET /ia/logs)

### Teste ponta a ponta
1. Ativar chatbot com pelo menos 1 opção válida
2. Enviar mensagem do WhatsApp para o número conectado
3. Verificar recebimento do menu de boas-vindas
4. Responder com número da opção (ex: 1)
5. Verificar: conversa vinculada ao departamento, confirmação enviada, log em bot_logs
6. Verificar: conversa aparece para usuários do departamento no CRM

---

## 8. Checklist de certificação (Z-API)

| Item | Verificação |
|------|-------------|
| WHATSAPP_PROVIDER | Deve ser `zapi` no .env |
| empresa_zapi | Tabela deve ter registro com `instance_id` da instância Z-API e `company_id` correto |
| Webhook Z-API | URL configurada no painel Z-API: `https://seu-dominio/webhooks/zapi?token=...` |
| Departamentos | Cadastrados em Configurações > Departamentos |
| Usuários | Vinculados aos departamentos (`departamento_id`) |
| Chatbot ativo | `enabled: true` e pelo menos 1 opção com `departamento_id` válido |
| Teste ponta a ponta | Cliente envia msg → recebe menu → responde "1" → conversa vai para departamento |

---

## 8. Checklist de certificação (Z-API)

Antes de considerar o chatbot pronto para produção:

- [ ] **WHATSAPP_PROVIDER=zapi** no .env (ou omitir — o default já é zapi)
- [ ] **empresa_zapi** com registro ativo: `company_id`, `instance_id`, `instance_token`, `client_token`, `ativo=true`
- [ ] Webhook Z-API configurado no painel: URL = `https://seu-dominio/webhooks/zapi?token=ZAPI_WEBHOOK_TOKEN`
- [ ] Departamentos cadastrados em Configurações > Departamentos
- [ ] Usuários com `departamento_id` vinculado aos setores
- [ ] Página de chatbot carrega GET /ia/config e GET /dashboard/departamentos
- [ ] Salvar configuração (PUT /ia/config) persiste sem erro
- [ ] Cliente envia mensagem → recebe menu de boas-vindas
- [ ] Cliente responde "1" (ou opção válida) → conversa vai para o departamento correto
- [ ] Cliente responde opção inválida → recebe mensagem de erro + menu novamente
- [ ] Logs aparecem em GET /ia/logs
