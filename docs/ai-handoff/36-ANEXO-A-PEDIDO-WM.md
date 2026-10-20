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

## 2. Retenção da idempotência

Por quanto tempo a API guarda um `comando_id` e o resultado associado? Isso define por quanto tempo
mantemos o payload de criação armazenado e por quanto tempo o reenvio do mesmo comando ainda serve
como verificação de um resultado incerto.

## 3. Timeout e SLA

Tempos esperados e limites internos de `produtos/consultar`, `orcamentos/preparar` e
`orcamentos/criar`, incluindo o limite da execução realtime que gera o `504 REALTIME_TIMEOUT`.
Nossos timeouts hoje são estimativa.

## 4. Rate limits

Existe limite de requisições nos endpoints `/api/v1/assistente`? Se sim, por token, por telefone ou
por endpoint, e com que janela? Encontramos limite documentado apenas no login administrativo.

## 5. Decimais na entrada

A saída está clara (preço `0.00##` invariant, estoque `0.000`, e a prévia devolve quantidade com três
casas). Na entrada, confirmar:

- escala máxima aceita em `quantidade` e `preco_confirmado`;
- regra de arredondamento, se houver;
- `quantidade` igual a `0` é recusada? O padrão `^\d+(?:\.\d+)?$` a aceita, e hoje nós a barramos
  localmente.

## 6. `bloquear_apos_criar`

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
