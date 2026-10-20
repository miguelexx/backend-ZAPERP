# Contrato da API WM — documentos recebidos

> **Não editar nada desta pasta.** São os documentos enviados pela WM, versionados aqui como
> recebidos em **20/10/2026**. Qualquer observação do ZapERP vai para
> [`../ai-handoff/36-ORCAMENTO-WM-INTEGRACAO.md`](../ai-handoff/36-ORCAMENTO-WM-INTEGRACAO.md),
> nunca dentro destes arquivos.

Eles existem porque a primeira rodada de análise foi feita sobre documentos colados em chat, que
se perderam — e sem eles nenhuma afirmação sobre o contrato era verificável.

## Versões recebidas

| Quando | O que veio |
|---|---|
| 20/10/2026, 1ª remessa | os 6 arquivos originais. O `openapi.yaml` daquela remessa está preservado como `openapi-2026-10-20-v1.yaml`. |
| 20/10/2026, 2ª remessa | `openapi.yaml` atualizado (1648 linhas, `info.version` continua 0.1.0) + `Integracao-ZapERP-API-WM-Atualizacao-2026-10-20.docx`, que **substitui os trechos desatualizados** do guia antigo. O `.txt` ao lado é só a extração de texto do mesmo docx, para busca — o docx é o original. |

A 2ª remessa fechou as duas pendências que travavam a criação (schema da prévia e schema do `200`
do `criar`) e trouxe a base URL de produção. Também trouxe uma **divergência sobre
`preco_negociado`** e uma feature nova sem relação com orçamento (`resumo-gestor`) — ver a seção 10
do [doc 36](../ai-handoff/36-ORCAMENTO-WM-INTEGRACAO.md).

| Arquivo | Finalidade |
|---|---|
| `openapi.yaml` | contrato HTTP e schemas (OpenAPI 3.0.3, `info.version` 0.1.0) — **a 2ª remessa** |
| `openapi-2026-10-20-v1.yaml` | o `openapi.yaml` da 1ª remessa, preservado para comparação |
| `Integracao-ZapERP-API-WM-Atualizacao-2026-10-20.docx` | guia atualizado; substitui trechos do `Integracao-ZapERP-API-WM.md` |
| `04-contratos-api.md` | regras funcionais, paginação, ambiguidades, erros |
| `09-seguranca.md` | credenciais, autorização, regras permanentes |
| `01-identidade-e-isolamento.md` | identidade empresa/sincronizador e a regra do MVP |
| `14-normalizacao-telefones.md` | normalização e equivalência de telefone |
| `Integracao-ZapERP-API-WM.md` | guia dirigido ao backend do ZapERP |

## Precedência (declarada pela própria WM)

```
1. openapi.yaml
2. documentação técnica específica (04, 09, 01, 14)
3. Integracao-ZapERP-API-WM.md (guia)
```

O guia declara isso em sua seção 20: se um exemplo dele divergir do `openapi.yaml`, vale o
`openapi.yaml`.

## Contexto importante ao ler

Estes documentos foram escritos tendo o **n8n/WhatsApp como consumidor principal** — há trechos
dirigidos a ele ("o n8n deverá preservar busca/itens/página", "usar numeração local 1–30",
"MAIS/ANTERIOR"). O ZapERP é o **segundo** consumidor, com credencial própria
(`ZAPERP_API_TOKEN`), e faz o mesmo fluxo por interface gráfica, com estado no servidor. Onde o
texto descreve comportamento de chatbot, leia como *requisito funcional*, não como desenho de
tela — o desenho do ZapERP está no doc 36.

## Quando a WM enviar uma versão nova

Substituir o arquivo aqui, registrar a data, e **só depois** comparar com o anterior e atualizar o
doc 36 e os testes de contrato (regra da seção 13 do doc 36). Nunca ajustar código antes de
atualizar o doc.
