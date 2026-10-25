# Anexo A — Pedido de informações à WM

> **Revisado em 20/10/2026, depois da 2ª remessa do contrato.** A versão anterior deste anexo pedia
> o schema da prévia e o schema do `200` da criação: **os dois já vieram** e estão implementados.
> O que segue é só o que continua aberto, mais duas perguntas novas que a 2ª remessa criou.
>
> Contrato analisado: o conjunto em [`../wm/`](../wm/README.md) — `openapi.yaml` da 2ª remessa e
> `Integracao-ZapERP-API-WM-Atualizacao-2026-10-20.docx`. Plano:
> [36-ORCAMENTO-WM-INTEGRACAO.md](36-ORCAMENTO-WM-INTEGRACAO.md).

## Obrigado — o que já resolvemos com a 2ª remessa

Para vocês saberem o que não precisa mais ser enviado:

- o shape da prévia de `pronto_para_confirmacao`, com `dados.itens[].preco_unitario` como preço
  oficial e a tabela de mapeamento prévia → criação;
- o shape do `200` de `/orcamentos/criar`, com `dados.codigo_pedido_erp` como número do orçamento;
- a base URL de produção (e confirmamos que é HTTPS, que é requisito do nosso cliente);
- a regra de que o `200` não distingue "criado agora" de "resultado idempotente": tratamos os dois
  como sucesso da mesma ação, e a distinção que exibimos vem do nosso estado local, não de
  `meta.criado_em`.

---

## Quatro comportamentos da busca que travam o atendente

> Medidos em uso real, contra uma instalação em produção, com o módulo já no ar. Não são dúvidas
> de contrato: são coisas que o atendente encontra na primeira hora de uso. Contornamos o que dava do
> nosso lado, mas o conserto de verdade é de vocês.

### A. A correspondência exata esconde todos os outros produtos

Quando o termo pesquisado é exatamente a descrição de algum produto, a resposta vem como produto
único e os demais que contêm a palavra **não aparecem**. Medido:

| termo | resultado |
|---|---|
| `filtro` | 1 produto (o item chamado literalmente "FILTRO") |
| `filtr` | **468 produtos** |
| `parafuso` | 1 |
| `parafus` | **285** |
| `piso` | 1 |
| `pis` | **42** |

Na prática, o atendente de uma loja de peças pesquisa "filtro" e vê um item, concluindo que o
sistema não carregou o catálogo.

**Pedido:** quando houver correspondência exata **e** outros produtos contendo o termo, devolver a
lista com o exato em primeiro lugar, em vez de suprimir o restante. Hoje contornamos repetindo a
consulta com o termo encurtado — funciona, mas é um remendo e gasta uma chamada a mais.

### B. A busca de cliente é por prefixo, e a de produto é por trecho

Medido com `cliente_busca` em `/orcamentos/preparar`:

| termo | resultado |
|---|---|
| `DINIZ` | nenhum cliente |
| `SILVA` | nenhum cliente |
| `MARIA APARECIDA AMADEI` | 3 candidatos |

O `04-contratos-api.md` confirma: nome de cliente é consultado **por prefixo**. Como produto é por
trecho, as duas caixas da mesma tela se comportam de formas diferentes, e ninguém adivinha isso —
pesquisar o sobrenome do cliente simplesmente não acha.

**Pedido:** aceitar trecho do nome na busca de cliente, como já acontece em produto. Por ora
orientamos o atendente a começar pelo primeiro nome ou colar o CPF/CNPJ (que casa por igualdade).

**Observação menor, do mesmo tema:** a busca de produto depende da ordem das palavras —
`filtro oleo` encontra, `oleo filtro` não. Se a correspondência passar a considerar os termos
independentemente da ordem, ajuda bastante.

### C. O trecho casa no MEIO de outra palavra, e o resultado vira ruído

Medido em 25/10/2026 na mesma instalação. Como a correspondência é por trecho em qualquer posição,
um termo curto e central do vocabulário da loja traz majoritariamente itens sem relação:

| termo | total | termo inicia alguma palavra | ruído |
|---|---|---|---|
| `cimento` | 6 | **1** | **5 (83%)** |
| `cimen` | 7 | 2 | 5 |
| `tinta` | 17 | 17 | 0 |
| `oleo` | 181 | 30 na página | 0 |
| `cabo` | 144 | 30 na página | 0 |

As cinco linhas de ruído de `cimento` são `ARREFE**CIMENTO**` e `ARREFI**CIMENTO**`: quem pesquisa
cimento recebe radiador e líquido de arrefecimento. O atendente não conclui "a busca casou um
trecho" — conclui que o sistema trouxe lixo, ou que o catálogo está errado.

**Pedido:** considerar **início de palavra** na busca por descrição, em vez de trecho em qualquer
posição (mantendo o trecho como segundo critério, se quiserem preservar o alcance atual). Os
separadores que importam, pela amostra real, são espaço, hífen e barra — descrições como
`R-1892`, `EXT/INT` e `AL221117 - RADIADOR` precisam continuar casando por qualquer uma de suas
palavras.

Contornamos do nosso lado ordenando a página que recebemos — relevantes primeiro, o restante
abaixo de um separador que diz "também contêm o termo" — mas é só apresentação: não alcança um
produto relevante que a paginação de vocês tenha deixado em outra página. Só a origem resolve.

### D. A busca de VENDEDOR não tem semântica declarada

O contrato diz o que acontece com o resultado (`VENDEDOR_NAO_ENCONTRADO` para zero,
`multiplos_vendedores` para mais de um, vendedor canônico para um) e diz a origem
("Funcionários ativos e vendedores, sem filtro de empresa"), mas **não diz como o texto casa** —
prefixo, trecho, ou igualdade.

Para cliente vocês declararam: `dbo.Clientes`, nome por prefixo com `Latin1_General_CI_AI`. Para
produto, trecho. Para vendedor, nada. São três caixas na mesma tela e o atendente não tem como
saber que cada uma se comporta de um jeito.

**Pedido:** declarar a regra de correspondência de `vendedor_busca` — e, se for prefixo como a de
cliente, dizer isso explicitamente no contrato, para podermos escrever a dica certa no campo.

---

## 1. `preco_negociado` está ativo? (pergunta nova, e é a mais urgente)

Encontramos uma divergência entre os dois documentos da 2ª remessa:

- o `openapi.yaml` acrescentou o schema `PrecoNegociadoOrcamento` e o campo opcional
  `preco_negociado` nos itens de **`/orcamentos/preparar`** e de **`/orcamentos/criar`**;
- o guia atualizado afirma, na seção 7.1, que *"a preparação não aceita `preco_confirmado` nem
  `preco_negociado`"*, e na seção 9.1 que a criação *"não recebe busca, paginação ou preço
  negociado"*.

Como a regra de precedência diz para seguir o `openapi.yaml`, mas o campo é monetário, preferimos
perguntar em vez de supor. Por ora **não enviamos** o campo — ele é opcional, então o fluxo funciona
sem ele.

**a)** O recurso está ativo na API implantada, ou o campo entrou no OpenAPI antes de valer?

**b)** A descrição do schema diz que *"Worker compatível revalida a referência e aplica a negociação
por linha"*. **Como o ZapERP sabe se o Worker daquele cliente é compatível?** Essa é a nossa maior
preocupação: se enviarmos um preço negociado para um Worker antigo e ele for ignorado em silêncio, o
atendente acredita ter dado um desconto e o ERP grava o preço cheio. Precisamos de uma forma de
detectar o suporte, ou de uma garantia de que a API recusa o campo quando o Worker não o aplica.

**c)** Se estiver ativo: o valor negociado substitui o `preco_unitario` na prévia (e portanto no
`preco_confirmado`), ou os dois convivem? Em caso de desconto, qual valor a prévia devolve em
`valor_total` e `valor_produtos`?

## 2. O `503 SINCRONIZADOR_OFFLINE` não está declarado nas rotas que o devolvem

Medido em 25/10/2026, em produção, com o sincronizador de uma loja fora do ar:

| rota | o que o `openapi.yaml` declara | o que respondeu |
|---|---|---|
| `/clientes/consultar` | `200`, `400`, `404` | **`503 SINCRONIZADOR_OFFLINE`** |
| `/orcamentos/preparar` | `200`, `400`, `404`, `502` | **`503 SINCRONIZADOR_OFFLINE`** |
| `/produtos/consultar` | `200`, `400`, `403`, `404` | `200` normalmente |
| `/acesso/validar` | `200`, `400`, `401`, `403` | `200` normalmente |

Nosso cliente já trata o `503` como falha segura e não grava nada, então não houve incidente. O
pedido aqui é de contrato e de documentação, por três motivos:

**a)** Declarar o `503` nas respostas de `/clientes/consultar` e `/orcamentos/preparar`. Hoje quem
gera cliente a partir do OpenAPI não produz esse caminho, e ele é o mais comum em operação real.

**b)** Confirmar, por rota, **quais dependem do sincronizador e quais são servidas do acervo já
sincronizado dentro da WM**. A medição acima sugere que `produtos` e `acesso` sobrevivem à loja
offline e que `clientes` e `preparar` não — queremos confirmação de vocês, não inferência nossa.
Essa assimetria tem consequência direta na tela: com a loja offline a busca de produto continua
funcionando, então o atendente monta o orçamento inteiro e só descobre o problema no botão de
calcular. Saber a lista exata nos deixa avisar antes.

**c)** Confirmar se `SINCRONIZADOR_OFFLINE` significa sempre *o sincronizador daquele cliente* e
nunca *indisponibilidade da WM*. Dissemos ao atendente que o caminho é conferir o computador do
ERP da própria loja; se o código também cobrir falha interna de vocês, a orientação está errada e
mandamos gente mexer na máquina errada.

## 3. Retenção da idempotência

Por quanto tempo a API guarda um `comando_id` e o resultado associado? Isso define por quanto tempo
mantemos o payload de criação armazenado e por quanto tempo o reenvio do mesmo comando ainda serve
como verificação de um resultado incerto.

## 4. Timeout e SLA

Tempos esperados e limites internos de `produtos/consultar`, `orcamentos/preparar` e
`orcamentos/criar`, incluindo o limite da execução realtime que gera o `504 REALTIME_TIMEOUT`.
Nossos timeouts hoje são estimativa.

## 5. Rate limits

Existe limite de requisições nos endpoints `/api/v1/assistente`? Se sim, por token, por telefone ou
por endpoint, e com que janela? Encontramos limite documentado apenas no login administrativo.

## 6. Decimais na entrada

A saída está clara (preço `0.00##` invariant, estoque `0.000`, e a prévia devolve quantidade com três
casas). Na entrada, confirmar:

- escala máxima aceita em `quantidade` e `preco_confirmado`;
- regra de arredondamento, se houver;
- `quantidade` igual a `0` é recusada? O padrão `^\d+(?:\.\d+)?$` a aceita, e hoje nós a barramos
  localmente.

## 7. `bloquear_apos_criar`

O campo é obrigatório em `preparar` e tem `default: true` em `criar`, e a prévia o devolve, mas não
encontramos a descrição do seu **efeito funcional** no ERP. O que exatamente ele bloqueia, e qual
valor vocês recomendam? Hoje enviamos `true` nas duas chamadas e guardamos o valor junto da prévia,
porque a prévia foi calculada sob aquela política.

---

## Isolamento entre empresas (ponto que gostaríamos de alinhar)

O `09-seguranca.md` deixa explícito que o Bearer do consumidor *"não restringe uma credencial a uma
única empresa"* e que *"esses consumidores são confiáveis para informar o telefone"*. Respeitamos o
desenho: resolvemos o telefone autorizado **apenas no servidor**, a partir da empresa autenticada no
nosso JWT; nenhum dado do navegador influencia esse telefone, e o cadastro do vínculo não é exposto
ao administrador do cliente.

Ainda assim, como o `ZAPERP_API_TOKEN` alcança qualquer empresa cadastrada e o telefone é o único
seletor de contexto, não temos como **verificar** que o telefone provisionado para uma empresa nossa
corresponde à mesma empresa do lado da WM: o `acesso/validar` responde apenas
`{ "autorizado": true }`, e o `/sincronizadores/identidade` usa o token do Worker, não o nosso.

Qualquer uma destas duas formas nos serve:

1. `acesso/validar` devolver uma **identidade opaca e estável** da instalação (um hash ou
   identificador sem significado externo), que possamos comparar com o vínculo provisionado; ou
2. um **processo oficial de provisionamento** em que a WM confirme por escrito, por empresa, qual
   telefone corresponde a qual cliente.

Até então operamos com **uma empresa piloto**, com o vínculo conferido manualmente, e não
liberaremos multiempresa.

---

## Material para começar os testes

**Credenciais:** falta o `ZAPERP_API_TOKEN` por canal seguro. A base URL já temos.

**Versões implantadas:** confirmar as versões da API WM e do Worker do ambiente que vamos consumir.
O `04-contratos-api.md` indica rollout **Worker primeiro, API depois, consumidor por último**, e a
paginação de 30 que usamos depende do Worker atualizado.

**Fixtures sanitizadas** (dados fictícios), para validarmos sem tráfego real:

| Caso |
|---|
| acesso autorizado e acesso negado |
| produto único e múltiplos produtos com paginação |
| cliente único e múltiplos clientes |
| vendedor ambíguo |
| produto ambíguo em item com `indice_item` diferente de zero |
| prévia completa (`pronto_para_confirmacao`) |
| criação nova |
| replay idempotente do mesmo `comando_id` |
| mesmo `comando_id` com payload diferente |
| `ORCAMENTO_DADOS_ALTERADOS` |
| sincronizador offline |
| recusa do ERP antes da escrita |
| timeout / resultado incerto |
