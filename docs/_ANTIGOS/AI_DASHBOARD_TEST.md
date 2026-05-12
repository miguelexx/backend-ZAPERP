# Assistente IA do Dashboard — Guia de Teste

## 1. Configurar a chave OpenAI

No arquivo `.env` do backend, preencha:

```env
OPENAI_API_KEY=sk-SUA_CHAVE_AQUI
AI_MODEL=gpt-4o-mini   # opcional; padrão já é gpt-4o-mini
```

Obtenha sua chave em: https://platform.openai.com/api-keys

---

## 2. Endpoint

```
POST /api/ai/ask
Authorization: Bearer <token_jwt>
Content-Type: application/json
```

### Body

| Campo        | Tipo    | Obrigatório | Descrição                              |
|--------------|---------|-------------|----------------------------------------|
| `question`   | string  | Sim         | Pergunta em linguagem natural          |
| `period_days`| number  | Não         | Período em dias (1–365, default: 7)    |

### Resposta de sucesso

```json
{
  "ok": true,
  "intent": "METRICS_OVERVIEW",
  "answer": "Hoje foram registrados 12 atendimentos...",
  "data": {
    "atendimentosHoje": 12,
    "conversasHoje": 8,
    "ticketsAbertos": 5,
    "taxaConversao": 62.5,
    "mensagensRecebidas": 340,
    "mensagensEnviadas": 210,
    "tempoMedioPrimeiraResposta": 4.2,
    "slaPercentualRespondidas": 87.5,
    "slaPercentualTotal": 73.3,
    "slaMinutos": 30
  }
}
```

### Resposta quando a pergunta não é reconhecida

```json
{
  "ok": false,
  "intent": "UNKNOWN",
  "answer": "Não entendi com segurança. Tente perguntar sobre...",
  "data": null
}
```

---

## 3. Exemplos de perguntas com curl

### Resumo geral das métricas

```bash
curl -X POST https://zaperp.wmsistemas.inf.br/api/ai/ask \
  -H "Authorization: Bearer SEU_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"question": "Resumo das métricas do dashboard"}'
```

### Atendente mais lento nos últimos 7 dias

```bash
curl -X POST https://zaperp.wmsistemas.inf.br/api/ai/ask \
  -H "Authorization: Bearer SEU_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"question": "Quem é o atendente mais lento nos últimos 7 dias?", "period_days": 7}'
```

### Top atendentes por conversas nos últimos 30 dias

```bash
curl -X POST https://zaperp.wmsistemas.inf.br/api/ai/ask \
  -H "Authorization: Bearer SEU_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"question": "Top atendentes por conversas nos últimos 30 dias", "period_days": 30}'
```

### Clientes mais ativos na última semana

```bash
curl -X POST https://zaperp.wmsistemas.inf.br/api/ai/ask \
  -H "Authorization: Bearer SEU_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"question": "Quais clientes mais mandaram mensagens na última semana?"}'
```

### Alertas de SLA agora

```bash
curl -X POST https://zaperp.wmsistemas.inf.br/api/ai/ask \
  -H "Authorization: Bearer SEU_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"question": "Tem alertas de SLA agora?"}'
```

---

## 4. Intents reconhecidos

| Intent                        | Quando é ativado                                      |
|-------------------------------|-------------------------------------------------------|
| `METRICS_OVERVIEW`            | Resumo geral, métricas, atendimentos, tickets         |
| `ATENDENTE_MAIS_RAPIDO`       | Atendente com menor tempo de 1ª resposta              |
| `ATENDENTE_MAIS_LENTO`        | Atendente com maior tempo de 1ª resposta              |
| `TOP_ATENDENTES_POR_CONVERSAS`| Ranking de atendentes por volume de conversas         |
| `CLIENTES_MAIS_ATIVOS`        | Clientes com mais mensagens enviadas no período       |
| `SLA_ALERTAS`                 | Conversas abertas fora do prazo de SLA               |
| `UNKNOWN`                     | Pergunta fora do escopo (retorna `ok: false`)         |

---

## 5. Segurança

- O modelo OpenAI **não executa SQL**. Ele apenas classifica a pergunta num intent da lista acima.
- Toda busca de dados é feita por funções pré-definidas em `services/aiDashboardService.js`.
- Todos os dados são filtrados por `company_id` (multi-tenant rigoroso).
- Rate limit: **10 perguntas por minuto** por empresa/IP.

---

## 6. Variáveis de ambiente completas

```env
OPENAI_API_KEY=sk-...          # obrigatório
AI_MODEL=gpt-4o-mini           # opcional (padrão: gpt-4o-mini)
```
