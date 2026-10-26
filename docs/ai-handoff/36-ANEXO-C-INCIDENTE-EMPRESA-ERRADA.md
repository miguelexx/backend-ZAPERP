# Anexo C — O telefone autorizado não alcança a EMPRESA #2

> **Para encaminhar à WM.** Relato de um comportamento medido em 26/10/2026 contra a API de
> produção `https://apiwmassistente.wmsistemas.inf.br`. Não é dúvida de contrato: é uma
> divergência entre o que o painel da WM mostra e o que a API responde para o mesmo telefone.
>
> Plano da integração: [36-ORCAMENTO-WM-INTEGRACAO.md](36-ORCAMENTO-WM-INTEGRACAO.md).
> Pedidos de contrato em aberto: [36-ANEXO-A-PEDIDO-WM.md](36-ANEXO-A-PEDIDO-WM.md).

## Em uma frase

O telefone autorizado `17981881417` é aceito pela WM (`acesso/validar` → `autorizado: true`), mas
as consultas feitas com ele **não alcançam o sincronizador da EMPRESA #2** e **devolvem o catálogo
de outra empresa** — enquanto o painel da WM mostra o sincronizador da EMPRESA #2 conectado e
sincronizado no mesmo minuto.

## O cenário

| | |
|---|---|
| Empresa esperada | **EMPRESA #2 — MARGRE MATERIAIS DE CONSTRUCAO LTDA**, CNPJ 14.684.306/0001-19 |
| Sincronizador | **#2**, nome "Sincronizador-Tijolar", versão 0.1.5 |
| Estado no painel da WM | Administrativamente **Ativo** · Banco SQL **Conectado** · **REALTIME Conectado** |
| Última comunicação / sincronização | **26/10/2026 10:54** |
| Telefone usado pelo ZapERP | `17981881417` (enviado como `5517981881417`) |
| Credencial | `ZAPERP_API_TOKEN` do ZapERP, Bearer |

## O que foi medido

Todas as chamadas abaixo usam **o mesmo telefone**, na mesma sessão, em 26/10/2026.

### 1. A autorização passa

```
POST /api/v1/assistente/acesso/validar
{ "telefone": "5517981881417" }
→ 200  { "autorizado": true }
```

### 2. Mas nada que seja realtime chega na loja

```
POST /api/v1/assistente/clientes/consultar
{ "telefone": "5517981881417", "codigo_cliente_erp": "0000002" }
→ 503  { "erro": "SINCRONIZADOR_OFFLINE" }        (2293 ms)

POST /api/v1/assistente/clientes/consultar
{ "telefone": "5517981881417", "busca": "ventura" }
→ 503  { "erro": "SINCRONIZADOR_OFFLINE" }        (2184 ms)

POST /api/v1/assistente/orcamentos/preparar
{ "telefone": "5517981881417", "cliente_busca": "...", "vendedor_busca": "...", "itens": [...] }
→ 503  { "erro": "SINCRONIZADOR_OFFLINE" }
```

Isto se repete desde 25/10 pela manhã, sem exceção, e continuou depois das 10:54 de 26/10 —
ou seja, **depois** do horário que o painel registra como última sincronização da EMPRESA #2.

### 3. E o catálogo que volta é de outra empresa

`produtos/consultar` responde `200` (vem de `meta.fonte: "cache_cloud"`, por isso sobrevive ao
sincronizador offline). O problema é **o conteúdo**.

Comparação do mesmo termo, na mesma hora:

| busca | Icthus da MARGRE (tela do cliente) | API WM com `17981881417` |
|---|---|---|
| `PIS` | **119 itens**, todos "PISO …" | 42 itens, **nenhum** PISO |
| `piso` | 119 | **1** — `AH217796/370 - PISO EXTENCAO PENEIRA 9650` |
| `formigres` | marca presente nas 119 linhas | **0** |
| `biancogres` | marca presente | **0** |
| `fioranno` | marca presente | **0** |
| `unigres` | marca presente | **0** |
| `porcelanato` | — | **0** |
| `azulejo` | — | **0** |

O único "PISO" que a API devolve é peça de colheitadeira, não revestimento.

Caracterizando o catálogo que a API entrega para esse telefone — amostra de **810 produtos**,
marcas mais frequentes:

```
GATES · INGA · CONTINENTAL · CNH · DULUB · METALBO · BANDEIRANTES
MARILIA · PEER · TRANSPOWER · GT-OIL · CORFIO · SUPRENS
```

São correias, rolamentos, lubrificantes e peças Case New Holland — um distribuidor agrícola e
industrial. A MARGRE é loja de material de construção, e as marcas dela
(FORMIGRES, BIANCOGRES, ROX, FIORANNO, UNIGRES, ALMEIDA, CEDASA, MULTICER) **não aparecem
nenhuma vez** na amostra.

## A leitura que isso sugere

As três observações juntas — autorização aceita, realtime inalcançável e catálogo de outro ramo —
apontam para o mesmo lugar: **o contato `17981881417` está cadastrado na WM sob uma empresa que
não é a EMPRESA #2.** As consultas então resolvem para o sincronizador daquela outra empresa, que
está offline, e o acervo em cache devolvido é o dela.

Não conseguimos confirmar isso do nosso lado, e é por isso que este documento existe: o telefone é
o **único** seletor de empresa do contrato, e a resposta de `acesso/validar` (`{"autorizado": true}`)
não diz a qual empresa o contato pertence. Do lado do consumidor não há como distinguir "autorizado
na empresa certa" de "autorizado em outra empresa".

## O que pedimos

**1.** Conferir, em `assistente_contatos`, sob **qual empresa** o telefone `17981881417` está
cadastrado. Se não for a EMPRESA #2, cadastrá-lo (ou indicar o contato correto) para a
**EMPRESA #2 — MARGRE MATERIAIS DE CONSTRUCAO LTDA, CNPJ 14.684.306/0001-19**.

**2.** Se ele **já estiver** sob a EMPRESA #2, então há um problema de roteamento na API: o
sincronizador #2 está conectado e, ainda assim, as consultas realtime desse telefone retornam
`SINCRONIZADOR_OFFLINE` e o acervo de outra empresa. Nesse caso os dados acima são a evidência.

**3.** Independentemente do resultado acima, e esta é a questão de fundo:

> **Como um consumidor da API pode confirmar que um telefone pertence à empresa que ele pretende
> atender?**

Hoje não pode. O `09-seguranca.md` declara que o Bearer *"não restringe uma credencial a uma única
empresa"* e que o consumidor é confiado para informar o telefone correto. O efeito prático é o que
este incidente mostrou: um telefone trocado faz o sistema ler — e, se o sincronizador estivesse no
ar, **escrever** — na empresa errada, sem que nada sinalize o erro. Nenhuma das respostas da API
nos permitiria detectar isso; só percebemos porque o cliente comparou a tela do Icthus dele com a
nossa.

Duas formas de fechar isso, qualquer uma resolve:

- **a)** `acesso/validar` devolver também um identificador opaco e estável da empresa do contato
  (não precisa ser nome nem CNPJ — serve um `empresa_ref` qualquer), que o consumidor grava no
  provisionamento e confere a cada uso;
- **b)** credencial por empresa, em vez de um Bearer que alcança todas.

Enquanto isso não existir, o isolamento entre empresas desta integração depende inteiramente de o
telefone ter sido digitado corretamente no provisionamento — e este incidente mostra que isso não
é suficiente.

## O que fizemos do nosso lado

- O módulo **não cria orçamento** com o estado atual: a criação exige uma prévia bem-sucedida, e
  `preparar` está devolvendo 503. Nenhum orçamento foi gravado em empresa nenhuma.
- As empresas 20 e 21 do ZapERP seguem provisionadas com esse telefone e **não serão usadas para
  criar orçamento** até o vínculo ser confirmado.
- Temos uma certificação pronta para rodar assim que o telefone correto for confirmado: ela
  verifica, contra dados reais que o cliente leu na tela do Icthus dele, que `pis` traz os PISO,
  que as marcas de revestimento existem, que `ventura` encontra `0014677 VENTURA MOTORS`, que
  `0000002` é `VENDA AO CONSUMIDOR`, e que a paginação devolve todos os registros sem repetir
  nem perder nenhum.
