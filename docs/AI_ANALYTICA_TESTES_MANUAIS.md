# IA analítica — bateria de testes manuais (`POST /api/ai/ask`)

Use `Authorization: Bearer <token>` e body JSON. O período base do classificador costuma ser **7 dias**; quando `period_days` **não** é enviado no body, vários intents usam janela **mínima de 90 dias** (par atendente+cliente, histórico de cliente, histórico de atendente, relatório completo) para não ocultar conversas antigas.

```http
POST /api/ai/ask
Content-Type: application/json

{"question": "..."}
```

Opcional: `{"question": "...", "period_days": 30}`

Após cada resposta, verificar em `data`:

- `analitica_ui.periodo_dias_efetivo`, `periodo_definido_na_requisicao`, `fonte_dados`
- `analitica_ui.alertas[]` (`codigo`, `mensagem`, `candidatos` com ids)
- Evidências com `mensagem_id`, `conversa_id`, etc., quando aplicável

---

## 1. `BUSCA_CONTEUDO_MENSAGENS`

| # | Objetivo | `question` (exemplo) | `period_days` | O que validar |
|---|----------|----------------------|---------------|----------------|
| 1.1 | Busca simples | "Qual conversa menciona boleto?" | omitido | `intent` = BUSCA…; evidências ou observação vazia; `fonte_dados` = mensagens_whatsapp |
| 1.2 | Data DD/MM | "Onde falaram de nota fiscal no dia 02/04?" | 30 | `data_referencia` implícita; resultados só naquele dia (UTC) |
| 1.3 | NF / NFE | "Buscar mensagens com nfe ou nf" | 14 | Termos expandidos; match robusto para siglas |
| 1.4 | PIX / pagamento | "Mensagens sobre pix ou pagamento" | 7 | Evidências coerentes |
| 1.5 | Atendente + busca | "Do João, o que falaram sobre entrega?" | — | Se vários "João": `alertas` AMBIGUIDADE ou filtro aplicado |
| 1.6 | Cliente + busca | "Cliente Maria Silva falou de desconto?" | — | Ambiguidade cliente se >1 Maria |
| 1.7 | Sem dados | "Mensagens sobre xyzabc123inexistente" | 7 | Lista vazia + lacuna clara na resposta |

---

## 2. `RANKING_TEMPO_RESPOSTA_ATENDENTES`

| # | Pergunta | Validar |
|---|----------|---------|
| 2.1 | "Quais atendentes demoram mais para responder?" | Ranking com `id`/`nome`/`tempo_medio_min`; período default |
| 2.2 | idem + `"period_days": 1` | `periodo_definido_na_requisicao` = true |

---

## 3. `ATENDENTE_MAIS_MENSAGENS_COM_TEMA`

| # | Pergunta | Validar |
|---|----------|---------|
| 3.1 | "Qual funcionário mais falou sobre promoção?" | `ranking` com `usuario_id`; termos promoção |
| 3.2 | "Quem mais mandou mensagem de desconto?" | omitido período | Léxico default promoção se termos vazios |

---

## 4. `QUALIDADE_ATENDIMENTOS_RANKING`

| # | Pergunta | Validar |
|---|----------|---------|
| 4.1 | "Quais atendimentos tiveram melhor avaliação?" | `melhor` com médias; exemplos com ids se houver dados |
| 4.2 | Empresa sem avaliações | observação de lacuna; listas vazias |

---

## 5. `SINAIS_INTERESSE_COMPRA`

| # | Pergunta | Validar |
|---|----------|---------|
| 5.1 | "Quais conversas indicam interesse de compra?" | Evidências; léxico comercial |
| 5.2 | "Orçamento ou proposta nos últimos 30 dias" | `period_days`: 30 |

---

## 6. `ATENDIMENTOS_LINGUAGEM_PROBLEMA`

| # | Pergunta | Validar |
|---|----------|---------|
| 6.1 | "Atendimentos com linguagem confusa ou reclamação" | `avaliacoes_baixas` com `avaliacao_id`, `atendimento_id`; mensagens padrão |
| 6.2 | Período curto sem dados | Lacunas explícitas |

---

## 7. `RELATORIO_ATENDENTE_COMPLETO`

| # | Pergunta | Validar |
|---|----------|---------|
| 7.1 | "Relatório completo de como o Pedro atende" | histórico + tempo + amostra (se nome único) |
| 7.2 | Nome ambíguo (dois usuários "Carlos") | `alertas` + `observacao` relatório interrompido; sem métricas consolidadas |

---

## 8. `CHAT_INTERNO_POR_TEMA`

| # | Pergunta | Validar |
|---|----------|---------|
| 8.1 | "O que os funcionários falaram no chat interno sobre reunião?" | `internal_message_id`, `internal_conversation_id` |
| 8.2 | Sem tema | Pergunta vaga → erro amigável ou termos extraídos da frase |
| 8.3 | Ambiente sem tabela | Mensagem de indisponível (se aplicável) |

---

## 9. `CLIENTES_POR_TEMA_FINANCEIRO`

| # | Pergunta | Validar |
|---|----------|---------|
| 9.1 | "Quais clientes falaram de boleto ou cobrança?" | `clientes[]` com `cliente_id`, exemplo ids |
| 9.2 | "Clientes que mencionaram nota fiscal em 02/04" | data + financeiro |

---

## 10. `CONVERSAS_POR_ASSUNTO_OPERACIONAL`

| # | Pergunta | Validar |
|---|----------|---------|
| 10.1 | "Conversas sobre erro no sistema ou login" | Agrupamento por `conversa_id` |
| 10.2 | "Suporte e protocolo nos últimos 14 dias" | `period_days`: 14 |

---

## 11. Par atendente ↔ cliente (`MENSAGENS_USUARIO_CLIENTE` / `CONVERSAS_*`)

| # | Pergunta | Validar |
|---|----------|---------|
| 11.1 | "O que o João falou com o cliente Ana?" | `mensagem_id` + `conversa_id` nas linhas; `criterio_resolucao` pode citar atendente_id, usuario_id, mensagens, atendimentos ou historico_atendimentos |
| 11.2 | Dois clientes "Ana Costa" | `ambiguidade_cliente` + `alertas` |
| 11.3 | Dois atendentes "Paulo" | `ambiguidade_usuario` |
| 11.4 | Atendente só aparece em `autor_usuario_id` (titular da conversa outro) | Mesmo assim há mensagens em `data.mensagens`; texto não nega interação |
| 11.5 | `"period_days": 7` no body | Janela respeitada (não força 90d); pode haver `recado_recuperacao` se vazio na janela |

---

## 12. `GENERAL_CHAT` / métricas

| # | Pergunta | Validar |
|---|----------|---------|
| 12.1 | "Resumo geral do dashboard" | Só KPIs; sem inventar conversas; texto não contradiz `overview.totalConversas` / mensagens |
| 12.2 | "Como melhorar vendas no mundo?" | Lacuna ou recusa de conselho genérico sem dados |
| 12.3 | `METRICS_OVERVIEW` ou pergunta que retorne só métricas | `atendimentosHoje` = 0 com `totalConversas` > 0 → resposta não diz “sem conversas” |

---

## 13. Múltiplas interpretações

| # | Pergunta | Validar |
|---|----------|---------|
| 13.1 | "Me fala de tudo" | GENERAL ou busca vaga; resposta honesta sobre limite |
| 13.2 | Mistura métrica + detalhe | Prioridade do classificador; `analitica_ui.intent` coerente |

---

## 14. Cenários de regressão (precisão)

| # | Cenário | `question` / body | Validar |
|---|---------|-------------------|---------|
| 14.1 | Wagner × Miguel WM (troca real) | "O que o Wagner falou com o cliente Miguel WM?" | `mensagens` ou erro honesto; nunca “não existe conversa” se `mensagens.length` > 0 |
| 14.2 | Resumo do dia | "Resumo das métricas de hoje" / dashboard | `conversasHoje`, `atendimentosHoje` e totais globais descritos sem contradizer `legenda_metricas` |
| 14.3 | Tickets abertos | "Quantos tickets abertos?" (se classificar métricas) | Coerente com `ticketsAbertos` e `status_atendimento` na amostra |
| 14.4 | Cliente nome parcial | "Histórico do cliente Miguel" | `resolveClienteCandidates` ou ambiguidade |
| 14.5 | Atendente nome parcial | "Conversas do atendente Wagner" | `HISTORICO_ATENDENTE` com conversas por atendente_id, usuario_id ou autor de mensagem |
| 14.6 | Sem `period_days` | omitido no body | Par atendente+cliente / histórico: janela efetiva ≥ 90 em `data.periodo_dias` ou `analitica_ui` |
| 14.7 | Conversa antiga | Mesma pergunta 14.1 com `"period_days": 7` | Pode retornar menos linhas; com omitido deve buscar amplo |
| 14.8 | Várias conversas do cliente | "Histórico do cliente X" | Lista `conversas` múltiplas; exclui `tipo` grupo / `@g.us` |
| 14.9 | Transferência | Cliente com conversa transferida entre atendentes | Par X+cliente ainda encontra via `atendimentos` ou `historico_atendimentos` ou mensagens |
| 14.10 | `usuario_id` na conversa | Atendente no campo `usuario_id` mas não em `atendente_id` | Ainda aparece em `MENSAGENS_USUARIO_CLIENTE` / histórico |

---

## Checklist rápido pós-deploy

- [ ] `data.analitica_ui` presente em respostas com objeto `data`
- [ ] Ambiguidades com `candidatos[].usuario_id` ou `cliente_id`
- [ ] Respostas com seções **Fatos** / **Inferência limitada** / **Lacunas** / **Alertas** quando o modelo cumprir o prompt
- [ ] Nenhum vazamento entre empresas (sempre mesmo `company_id` do token)
