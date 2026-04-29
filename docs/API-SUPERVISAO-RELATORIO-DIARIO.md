# API Supervisao - Relatorio Diario

## Endpoint

- Metodo: `GET`
- Rota: `/api/supervisao/relatorio-diario`
- Permissao: `admin`, `administrador`, `supervisor`
- Autenticacao: `Bearer JWT` (middleware existente)

## Query params

- `data` (opcional): formato `YYYY-MM-DD`
  - quando nao informado, usa o dia atual no timezone do servidor

## Regras

- Aplica filtro obrigatorio por `company_id` em todas as consultas.
- Retorna apenas dados da empresa do usuario autenticado.

## Resposta (exemplo)

```json
{
  "data_referencia": "2026-04-28",
  "periodo": {
    "inicio": "2026-04-28T03:00:00.000Z",
    "fim": "2026-04-29T03:00:00.000Z"
  },
  "totais": {
    "atendimentos_dia": 18,
    "conversas_abertas": 42,
    "aguardando_funcionario": 11,
    "atrasados_30min": 4,
    "tempo_medio_resposta_minutos": 12.4
  },
  "ranking_funcionarios": [
    {
      "usuario_id": 7,
      "nome": "Ana",
      "atendimentos_assumidos_hoje": 5,
      "conversas_em_atendimento": 3,
      "clientes_sem_resposta": 2,
      "finalizadas_hoje": 4,
      "atendimentos_finalizados_hoje": 4,
      "tempo_medio_resposta_minutos": 8.9
    }
  ],
  "departamentos_maior_demanda": [
    {
      "departamento_id": 2,
      "departamento_nome": "Financeiro",
      "total_conversas": 19
    }
  ],
  "clientes_criticos": [
    {
      "conversa_id": 123,
      "cliente_nome": "Joao Silva",
      "telefone": "34999999999",
      "atendente_nome": "Ana",
      "departamento_nome": "Financeiro",
      "minutos_aguardando": 74,
      "nivel": "critico",
      "resumo_conversa": "Cliente aguardando retorno sobre boleto."
    }
  ]
}
```
