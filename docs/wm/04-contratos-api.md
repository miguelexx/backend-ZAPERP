# Contratos da API

**IMPLEMENTADO:** inventário conferido em app.ts, routers e schemas do código
oficial. openapi.yaml é complementar e não cobre sozinho todo o inventário.
IDs de segurança são resolvidos pelo backend, não pelo body.

## Rotas públicas

| Método | Caminho | Retorno |
| --- | --- | --- |
| GET | /health | JSON com status ok |
| GET | /openapi.yaml | Arquivo OpenAPI versionado |

## Rotas autenticadas pelo token do Worker

| Método | Caminho | Entrada / retorno principal |
| --- | --- | --- |
| GET | /api/v1/sincronizadores/identidade | Sem parâmetros de identidade; sincronizador e empresa do token |
| POST | /api/v1/sincronizadores/heartbeat | versao, sql_conectado, ultima_sincronizacao; 204 |
| GET | /api/v1/sincronizacoes/vendas/checkpoint | entidade, ultima_data_atualizacao local ou null |
| GET | /api/v1/sincronizacoes/produtos/checkpoint | Checkpoint de produtos |
| POST | /api/v1/sincronizacoes/vendas | vendas[] de cabeçalhos; vendas_processadas, checkpoint |
| POST | /api/v1/sincronizacoes/produtos | produtos[]; produtos_processados, checkpoint |
| POST | /api/v1/sincronizacoes/estoques | produtos[] com código e estoque_previsto; 204 ou 409 |
| GET | /api/v1/sincronizacoes/vendas/reconciliacao | data_emissao_inicial, cursor opcional, limite; pedidos/proximo_cursor |
| POST | /api/v1/sincronizacoes/vendas/exclusoes | pedidos[] com códigos locais; vendas_marcadas |

A venda individual é strict e rejeita itens, mesmo lista vazia. Datas de origem
são YYYY-MM-DDTHH:mm:ss.fff sem Z/offset. A API calcula venda_efetiva.
Heartbeat aceita data técnica com timezone; após a 012, sql_conectado é gravado
com os campos anteriores, sem mudança de entrada/resposta. 012 não aplicada no cloud.

## Rotas autenticadas por credencial do consumidor

Todas usam telefone para resolver assistente_contatos. Os contratos estão em
[assistente.schemas.ts](../src/modules/assistente/assistente.schemas.ts) e
[relatorios.schemas.ts](../src/modules/assistente/relatorios/relatorios.schemas.ts).

n8n e backend ZapERP acessam os mesmos endpoints com credenciais Bearer próprias.
O Bearer autentica o consumidor, não a empresa ou o comprador; telefone é o contato
autorizado da instalação e continua determinando o contexto. Telefone inexistente
ou inativo retorna 403 CONTATO_NAO_AUTORIZADO mesmo com Bearer válido.
Ausência/credencial inválida/Bearer malformado retornam 401 TOKEN_ASSISTENTE_INVALIDO.
Token puro sem o esquema Bearer não é aceito. Identificação interna do consumidor
não integra os payloads/respostas nem substitui a autorização por telefone.

| Método | Caminho | Entrada principal / execução |
| --- | --- | --- |
| POST | /api/v1/assistente/produtos/consultar | busca XOR codigo_produto_erp, pagina; limite obsoleto/ignorado; cache/realtime |
| POST | /api/v1/assistente/vendas/consultar | data_inicio/data_fim; resumo cloud ou realtime |
| POST | /api/v1/assistente/vendas/ranking-produtos | Período, limite, ordenar_por; realtime |
| POST | /api/v1/assistente/vendas/ranking-grupos | Período, limite, ordenar_por; realtime |
| POST | /api/v1/assistente/vendas/comparar | periodo_a e periodo_b; realtime |
| POST | /api/v1/assistente/recebimentos/consultar | tipo a_receber/recebidos e período, ou vencidos/data_referencia |
| POST | /api/v1/assistente/clientes/consultar | busca XOR codigo_cliente_erp, pagina; realtime |
| POST | /api/v1/assistente/orcamentos/preparar | Cliente e vendedor por código XOR busca, itens, bloquear_apos_criar |
| POST | /api/v1/assistente/orcamentos/criar | comando_id UUID, códigos canônicos, itens, bloquear_apos_criar |
| POST | /api/v1/assistente/relatorios/gerar | tipo vendas/estoque/recebimentos, parametros; application/pdf |

Na criação, quantidade e preco_confirmado são strings decimais; vendedor_nome
não integra o contrato. Preparação exige exatamente um entre vendedor_codigo_erp
e vendedor_busca (até 100 caracteres), como cliente_codigo_erp XOR cliente_busca.
Busca de vendedor consulta Funcionários ativos e vendedores, sem filtro de empresa.
Zero resultados: VENDEDOR_NAO_ENCONTRADO. Mais de um: dados.status=multiplos_vendedores,
candidatos com codigo_vendedor_erp e nome; não há seleção automática.
Um resultado: pronto_para_confirmacao com vendedor canônico. Criação continua
exigindo vendedor_codigo_erp e rejeita vendedor_busca.

### Candidatos enriquecidos — clientes e produtos

CONSULTAR_CLIENTES (/clientes/consultar) e PREPARAR_ORCAMENTO (/orcamentos/preparar)
mantêm dados.status=multiplos_clientes e dados.candidatos[]. Cada candidato contém
codigo_cliente_erp, nome, cpf, cnpj e inscricao_estadual. A origem é dbo.Clientes:
[Código Cliente], [Nome Cliente], [CPF], [CNPJ] e **[IE]**. IE foi confirmado por
SELECT em sys.columns/sys.types: varchar(18), nullable; CPF varchar(14) e CNPJ
varchar(18), ambos nullable. Não usar documentos do avalista/cônjuge.
Documentos NULL, vazios ou só espaços viram null; o conteúdo não recebe máscara
nova nem perde pontuação. Valores fiscais como ISENTO são preservados.
Cliente único mantém apenas codigo_cliente_erp/nome, como antes.

PREPARAR_ORCAMENTO mantém dados.status=produto_ambiguo, indice_item e candidatos[].
Produto candidato contém codigo_produto_erp, descricao, unidade e agora
preco_unitario/estoque_previsto como strings. Os dois valores vêm do mesmo
ProdutoAtualOrigem já carregado de dbo.Estoque.[Preço Unitário]/[Estoque Previsto],
sem nova consulta. Serialização igual à prévia: preço 0.00## invariant (ex. 33.038);
estoque 0.000 invariant (ex. -2.125), preservando zero/negativo. Não usar Estoque Atual.
API repassa dados realtime sem transformação/schema de saída que remova campos.

Campos são aditivos; seleção pelo usuário, COLLATE, confirmação,
cálculo e escrita não mudam. /produtos/consultar continua com candidatos do cache
cloud, agora paginados conforme seção abaixo; não rotular o estoque do cache como atual.
O n8n não foi alterado: futuramente deve exibir esses campos quando não nulos,
formatar moeda/documentos visualmente e manter a escolha explícita pelo usuário.

### Elegibilidade e paginação de PREPARAR_ORCAMENTO

Somente /orcamentos/preparar aceita cliente_pagina, vendedor_pagina e, dentro
de cada item, produto_pagina. São inteiros opcionais >= 1 (padrão 1, máximo
técnico Int32 2147483647); OFFSET usa Int64. tamanho_pagina é fixo em 30 e não
pode ser enviado pelo cliente. Por código explícito usar página 1.

Cliente buscado para orçamento: Inativo=0 AND Bloqueado=0 antes de COUNT e
OFFSET/FETCH. Consulta por código não esconde essas flags: cliente existente
invalidado continua retornando CLIENTE_INVALIDO. /clientes/consultar permanece
sem esse filtro; possui paginação própria conforme seção abaixo.

Vendedor: Ativo=1 AND Vendedor=1, sem filtro por Código Empresa.
Produto: Ativo=1, sem filtro por quantidade; estoque zero/negativo é permitido.
Os registros são consultados novamente ao selecionar códigos. A revalidação
final da escrita e a confirmação não foram alteradas.

multiplos_clientes, multiplos_vendedores e produto_ambiguo incluem em dados:
{paginacao:{pagina,tamanho_pagina:30,total,tem_mais,tem_anterior}}.
total é a contagem global elegível, não candidatos.length; candidatos tem até
30 por página. Produto preserva indice_item zero-based. A última página com um
único registro não resolve automaticamente se total>1. Correspondência textual
exata de produto mantém Trim/OrdinalIgnoreCase da preparação anterior.
Para verificar essa unicidade global sem mudar COLLATE ou carregar toda a lista,
o Worker pode ler blocos SQL adicionais de até 30 até encontrar dois exatos ou
esgotar o conjunto. Buscas grandes podem custar mais leituras; timeout não foi
alterado. COUNT e página são leituras no mesmo batch, não um snapshot imutável.

Página além da última retorna HTTP 400 {erro:"PAGINA_FORA_DO_INTERVALO"}, sem
clamp e sem virar "não encontrado". Busca vazia: página 1 mantém erro de registro
não encontrado; página >1 retorna erro de página. Página não positiva/fracionária
é rejeitada no schema da API e defensivamente no Worker. Se o conjunto mudar
durante a leitura, pode ser necessário repetir a preparação. Erros já existentes
como CLIENTE_INVALIDO/PRODUTO_INATIVO não tiveram seu mapeamento HTTP alterado.

n8n não foi alterado. Depois deverá preservar busca/itens/página/indice_item,
substituir a lista pelas opções da página atual e usar numeração local 1–30.
MAIS/ANTERIOR só requisitam página permitida pelos metadados. Seleção envia o
código canônico novamente (sem página antiga); CANCELAR limpa o contexto.
Não habilitar confirmação até receber pronto_para_confirmacao.
Consulta normal de produto preserva: texto filtra ativos no cache,
código explícito pode retornar ativo=false, cache pode estar defasado. O novo
status produto_inativo ficou para uma etapa posterior.

### Consultas normais — produtos e clientes

Ambos aceitam `pagina` inteiro opcional (padrão 1, máximo técnico Int32),
com página fixa de 30. Não aceitam tamanho de página configurável.
Resultados ambíguos preservam `dados.status` e as listas existentes:
`multiplos_produtos` / `produtos`, `multiplos_clientes` / `candidatos`.
Acrescentam `dados.paginacao`:

```json
{"pagina":1,"tamanho_pagina":30,"total":94,"tem_mais":true,"tem_anterior":false}
```

`total` é global. Última página com um candidato não significa resultado único.
Página além do total retorna HTTP 400 `PAGINA_FORA_DO_INTERVALO`; conjunto vazio
na página 1 mantém erro de não encontrado e página >1 retorna erro de página.
Código explícito usa página 1. Não há clamp silencioso.

Produtos: descrição/marca por ocorrência, sem diferenciar caixa e os acentos
portugueses mapeados por `translate(lower(...))`. Termo e campos usam a mesma
expressão, sem extensão/migration. Identificadores ERP/barras/fabricante usam
igualdade exata, sem normalização textual. Texto e identificadores não se confundem.
Um resultado global resolve diretamente; uma única correspondência exata global
de descrição normalizada ou identificador também pode resolver. Duas correspondências
exatas não resolvem arbitrariamente. Marca não participa da correspondência exata.
COUNT, exatos e página compartilham uma instrução/snapshot PostgreSQL, com ordenação
por prioridade, descrição e desempate por código ERP. O produto resolvido mantém
consulta realtime com fallback cloud; a descoberta de candidatos permanece cloud.
`limite` continua aceito entre 1–20, padrão 10, mas está **obsoleto e ignorado**:
não modifica tamanho da página, total ou resolução. Limites dos rankings não mudaram.

Clientes: a API encaminha `{busca OU codigo_cliente_erp, pagina}` na operação
`CONSULTAR_CLIENTES`, sem telefone ou ID de empresa no payload. O envelope realtime
permanece o mesmo. O Worker consulta dbo.Clientes, nome por prefixo com
`Latin1_General_CI_AI`, CPF/CNPJ/código por igualdade; não aplica Inativo/Bloqueado
como filtros. Mantém campos dos candidatos e resposta de cliente único.
COUNT e página usam o mesmo batch SQL, com desempate por Código Cliente;
não prometem snapshot imutável entre leituras/solicitações concorrentes.

Rollout coordenado: **Worker primeiro, API depois, n8n por último**. Worker antigo
não oferece esta paginação. Callers legados sem pagina recebem página 1; o n8n
existente pode continuar enviando limite, mas ainda precisa integrar navegação.
Nenhum workflow n8n foi alterado. PREPARAR_ORCAMENTO, criação, rankings e relatórios
não foram modificados por esta implementação.

Estoque PDF usa situacao e status_cadastro
(ativos default, inativos ou todos). Recebimentos PDF usa modo, não tipo
dentro de parametros. Respostas JSON das consultas usam dados/meta;
PDF é binário. Períodos realtime de vendas/rankings têm limite de 31 dias inclusivos.

## Canal realtime implementado

Upgrade GET /ws/sincronizador com Bearer do Worker.
Envelope API: tipo=requisicao, request_id, operacao, payload.
Resposta Worker: tipo=resposta, request_id, sucesso, dados, erro.
Operações são enumeradas em realtime-connection-manager.ts e despachadas pelo
Worker: produto atual, resumo, rankings, comparação, dados de vendas/estoque,
recebimentos, clientes, PREPARAR_ORCAMENTO e CRIAR_ORCAMENTO.
Não há operação para SQL arbitrário.

## Erros relevantes

Worker HTTP: 401 token_ausente/token_invalido. Assistente: 401
TOKEN_ASSISTENTE_INVALIDO, 403 CONTATO_NAO_AUTORIZADO, 400 payload_invalido/
PERIODO_INVALIDO, 503 SINCRONIZADOR_OFFLINE, 504 REALTIME_TIMEOUT, 502 erro de origem.
Criação pode retornar 409 COMANDO_ID_REUTILIZADO, COMANDO_NAO_REEXECUTADO
ou RESULTADO_INCERTO. Consulte shared/http/errors.ts para o mapeamento completo.

## Contrato estável de identidade — IMPLEMENTADO

GET /api/v1/sincronizadores/identidade

Authorization: Bearer <token do Worker>. O token sozinho resolve
sincronizador ativo → empresa → CNPJ normalizado. Query/body não selecionam contexto.
Sem credencial: 401 token_ausente; token inválido/inativo: 401 token_invalido.
Não retorna token/hash/secrets. nome pode ser null. OpenAPI descreve o contrato.

Resposta 200; CNPJ abaixo é fixture fictícia:

```json
{
  "sincronizador": { "id": 12, "ativo": true },
  "empresa": { "id": 7, "cnpj": "12345678000190", "nome": "Empresa Exemplo" }
}
```

Rotas administrativas implementadas na Etapa 4 reutilizam provisionamento do
backend, separadas das credenciais Worker/consumidores. Recusas de identidade do
Worker na criação são falhas seguras anteriores ao INSERT, não resultado incerto.

## Administração — IMPLEMENTADO na Etapa 4

Prefixo /api/v1/admin. POST /auth/login é a única rota sem sessão, recebe
{usuario, senha} JSON; retorna {usuario_id, usuario, nome, expira_em, csrf_token} e cookie HttpOnly.
GET /auth/me retorna os mesmos campos. POST /auth/logout exige X-WM-CSRF e retorna 204.
Todas as rotas restantes exigem cookie válido; alterações exigem X-WM-CSRF.

| Rotas | Contrato |
| --- | --- |
| GET /usuarios | Lista usuários sem senha_hash |
| POST /usuarios | {nome, usuario, senha}; usuário normalizado único, ativo=true |
| PATCH /usuarios/:id | {nome?, ativo?}; impede desativar último ativo |
| POST /usuarios/:id/redefinir-senha | {senha}; revoga todas as sessões do usuário |
| GET /empresas, GET /empresas/:id | Pesquisa nome/CNPJ, limite/offset, resumo do sincronizador |
| POST /empresas | {nome, cnpj}; backend atribui codigo_erp=1, mantido na resposta |
| PATCH /empresas/:id | {nome?, cnpj?}, ao menos um; CNPJ imutável após provisionar, codigo_erp não editável |
| POST /empresas/:empresaId/sincronizador | {nome}; 201 empresa_id, sincronizador_id, token emitido uma vez |
| GET /sincronizadores/:id | Dados sem token/hash |
| POST /sincronizadores/:id/ativar, /desativar | Body vazio; ativar mantém token; desativar encerra WSS local |
| POST /sincronizadores/:id/rotacionar-token | Body vazio; token novo uma vez, ativo preservado, WSS local encerrado |
| GET/POST /sincronizadores/:id/contatos | Listar/cadastrar telefone, nome?, ativo? |
| PATCH /sincronizadores/:id/contatos/:contatoId | Editar campos/ativo com vínculo validado no WHERE |
| GET /sincronizadores/:id/status | Campos PostgreSQL e realtime_conectado da instância atual |

Corpos strict: IDs substitutos e tokens manuais são recusados. Sem DELETE.
Cache-Control no-store. Regras especiais, erros, limites e exemplos completos em
[Etapa 4](13-etapa4-backend-administrativo.md) e openapi.yaml.
