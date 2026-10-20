# Integração ZapERP × API WM

> Guia específico para o backend do ZapERP.
> Este documento complementa o `openapi.yaml` e a documentação técnica enviada pela WM.
> Em caso de divergência de nomenclatura, schema, enum ou resposta, **o `openapi.yaml` é a fonte de verdade do contrato HTTP**.

## 1. Objetivo

O ZapERP deve consumir exclusivamente a **API WM** por HTTPS.

O ZapERP não deve acessar diretamente:

- PostgreSQL da API WM;
- SQL Server / Icthus;
- WebSocket do WM Sincronizador;
- WM Sincronizador;
- queries SQL;
- connection strings;
- `empresa_id`;
- `sincronizador_id`;
- token do WM Sincronizador.

Arquitetura esperada:

```text
Frontend ZapERP
      ↓
Backend ZapERP
      ↓ HTTPS + Bearer
    API WM
      ↓
[cloud / realtime]
      ↓
WM Sincronizador
      ↓
SQL Server / Icthus
```

A decisão entre dados cloud e consulta em tempo real pertence à API WM.

## 2. Base URL

A Base URL será fornecida pela WM separadamente.

Os endpoints do Assistente usam o prefixo:

```text
/api/v1/assistente
```

Exemplo conceitual:

```text
https://<host-api-wm>/api/v1/assistente/produtos/consultar
```

Não hardcodar URL de desenvolvimento.

## 3. Autenticação

O ZapERP possui uma credencial própria:

```text
ZAPERP_API_TOKEN
```

Ela é independente da credencial do n8n/WhatsApp e dos tokens dos WM Sincronizadores.

Todas as chamadas devem utilizar:

```http
Authorization: Bearer <ZAPERP_API_TOKEN>
Content-Type: application/json
```

O prefixo `Bearer` é obrigatório.

A credencial real será fornecida separadamente por canal seguro.

### Segurança da credencial

A credencial deve permanecer somente no backend do ZapERP.

Não deve:

- ser enviada ao navegador;
- ficar no frontend;
- ser versionada em Git;
- aparecer em logs;
- ser retornada em erros;
- ser reutilizada como token do Worker.

Fluxo correto:

```text
Frontend ZapERP
      ↓
Backend ZapERP
      │ adiciona Authorization: Bearer ...
      ↓
    API WM
```

## 4. Autenticação do consumidor x identificação da empresa

São responsabilidades diferentes.

### Bearer Token

O `ZAPERP_API_TOKEN` autentica o **ZapERP como consumidor da API**.

Ele não seleciona empresa, tenant ou sincronizador.

### Telefone

O campo `telefone` identifica um **contato autorizado da instalação/empresa**.

Ele não representa necessariamente o cliente/comprador do orçamento.

O ZapERP deve enviar o telefone do usuário/contato autorizado associado à operação.

A API WM usa esse telefone para resolver internamente o contexto correto e preservar o isolamento entre empresas.

Não enviar `empresa_id`, `sincronizador_id`, banco ou connection string para selecionar livremente uma empresa.

## 5. Normalização de telefone

A API WM possui normalização centralizada de telefones brasileiros.

O ZapERP não precisa reproduzir regras próprias de:

- máscara;
- espaços;
- parênteses;
- hífen;
- DDI brasileiro;
- equivalência compatível com o nono dígito.

Exemplos de entrada equivalentes podem ser normalizados pela API:

```text
(34) 99184-7800
55 34 99184-7800
5534991847800
```

Para os detalhes, consultar:

```text
14-normalizacao-telefones.md
```

## 6. Validação inicial de acesso

Antes de iniciar uma operação, o ZapERP pode validar autenticação + autorização do contato utilizando:

```http
POST /api/v1/assistente/acesso/validar
```

Headers:

```http
Authorization: Bearer <ZAPERP_API_TOKEN>
Content-Type: application/json
```

Body conceitual:

```json
{
  "telefone": "5534991847800"
}
```

Contato autorizado:

```json
{
  "autorizado": true
}
```

Um Bearer válido não ignora a validação do telefone.

## 7. Endpoints principais

Os schemas exatos de entrada e saída estão no `openapi.yaml`.

### Acesso

```text
POST /api/v1/assistente/acesso/validar
```

### Produtos

```text
POST /api/v1/assistente/produtos/consultar
```

### Clientes

```text
POST /api/v1/assistente/clientes/consultar
```

### Vendas

```text
POST /api/v1/assistente/vendas/consultar
POST /api/v1/assistente/vendas/ranking-produtos
POST /api/v1/assistente/vendas/ranking-grupos
POST /api/v1/assistente/vendas/comparar
```

### Recebimentos

```text
POST /api/v1/assistente/recebimentos/consultar
```

### Relatórios

```text
POST /api/v1/assistente/relatorios/gerar
```

### Orçamentos

```text
POST /api/v1/assistente/orcamentos/preparar
POST /api/v1/assistente/orcamentos/criar
```

## 8. Consulta de produto

Exemplo por busca:

```json
{
  "telefone": "5534991847800",
  "busca": "CHAPA DESLIZANTE"
}
```

Exemplo por código:

```json
{
  "telefone": "5534991847800",
  "codigo_produto_erp": "0000474"
}
```

A API pode resolver um único produto ou retornar candidatos.

Quando houver ambiguidade, o ZapERP não deve escolher arbitrariamente um item. Deve apresentar as opções ao usuário e aguardar a escolha.

## 9. Fluxo obrigatório de orçamento

Fluxo correto:

```text
preparar
   ↓
resolver ambiguidades
   ↓
apresentar prévia
   ↓
obter confirmação explícita
   ↓
criar
```

### 9.1 Preparar

```http
POST /api/v1/assistente/orcamentos/preparar
```

Essa operação **não grava no ERP**.

Ela valida cliente, vendedor, produtos, quantidades e os dados necessários para montar a prévia.

A API pode retornar ambiguidades, por exemplo:

```text
multiplos_clientes
multiplos_vendedores
produto_ambiguo
```

O ZapERP deve apresentar os candidatos e aguardar a escolha do usuário.

Nunca escolher arbitrariamente um candidato.

### 9.2 Prévia

Depois da preparação bem-sucedida, o ZapERP deve manter os códigos canônicos e valores retornados pela API.

A confirmação do usuário deve ocorrer depois da apresentação da prévia.

### 9.3 Criar

```http
POST /api/v1/assistente/orcamentos/criar
```

Essa operação grava no ERP através do fluxo controlado:

```text
ZapERP → API WM → WM Sincronizador → SQL Server/Icthus
```

O ZapERP nunca grava diretamente no SQL Server.

## 10. Revalidação antes da escrita

A criação revalida os dados no SQL Server/Icthus.

Se preço ou outro dado relevante mudar entre preparação e criação, a API pode recusar a operação.

Fluxo esperado:

```text
nova preparação
      ↓
nova prévia
      ↓
nova confirmação
      ↓
nova tentativa controlada
```

O ZapERP nunca deve apresentar um valor e gravar silenciosamente outro.

## 11. Idempotência e `comando_id`

A criação utiliza:

```text
comando_id
```

no formato UUID.

Cada **nova confirmação de negócio** deve receber um novo UUID.

Exemplo:

```text
550e8400-e29b-41d4-a716-446655440000
```

### Regra crítica

Se a mesma requisição precisar ser repetida por problema de transporte, reutilizar **o mesmo `comando_id`**.

Nunca gerar outro UUID apenas porque houve:

- timeout;
- perda de conexão;
- erro de transporte;
- retry técnico.

## 12. `RESULTADO_INCERTO`

Em determinados cenários de escrita, a API pode indicar:

```text
RESULTADO_INCERTO
```

Nessa situação:

- não gerar outro `comando_id`;
- não repetir automaticamente;
- não criar uma nova operação para "corrigir";
- manter o estado da operação;
- apresentar tratamento controlado ao usuário;
- permitir verificação posterior.

## 13. Reutilização de `comando_id`

Comportamento esperado:

```text
mesmo comando_id + mesma operação já concluída
→ retorna resultado idempotente
→ não cria novamente
```

```text
mesmo comando_id + payload diferente
→ conflito
→ não criar
```

O ZapERP deve manter o `comando_id` durante todo o ciclo da operação até obter um estado final seguro.

## 14. Disponibilidade e origem dos dados

A API pode atender consultas utilizando:

```text
tempo_real
```

ou:

```text
cache_cloud
```

Quando retornados, os metadados de origem devem ser preservados.

Exemplo conceitual:

```json
{
  "meta": {
    "fonte": "tempo_real"
  }
}
```

ou:

```json
{
  "meta": {
    "fonte": "cache_cloud",
    "sincronizado_em": "..."
  }
}
```

### Escritas

Operações de escrita dependem do ambiente local estar disponível.

Não existe fallback de escrita pelo PostgreSQL cloud.

## 15. Tratamento de erros

Consultar sempre o `openapi.yaml` para os status específicos de cada endpoint.

Principais códigos:

| HTTP | Significado geral |
|---|---|
| `400` | payload ou regra inválida |
| `401` | credencial Bearer ausente/inválida |
| `403` | contato não autorizado |
| `404` | recurso não encontrado, quando aplicável |
| `409` | conflito, idempotência, comando em andamento ou resultado incerto |
| `502` | ERP recusou a operação antes da escrita, conforme endpoint |
| `503` | Sincronizador/serviço indisponível |
| `504` | timeout |

Não implementar retry cego em operações de escrita.

O tratamento deve respeitar:

- `comando_id`;
- idempotência;
- `RESULTADO_INCERTO`;
- códigos estruturados retornados pela API.

## 16. Segurança e isolamento

O ZapERP deve tratar a API WM como a única fronteira de integração.

Não deve:

- executar ou enviar SQL arbitrário;
- acessar PostgreSQL diretamente;
- acessar SQL Server diretamente;
- abrir WebSocket com o Worker;
- utilizar token do WM Sincronizador;
- confiar em IDs de empresa enviados pelo frontend;
- expor a credencial da API no navegador.

O backend do ZapERP deve validar sua própria sessão/usuário antes de chamar a API WM.

A API WM realiza sua própria autorização por telefone e isolamento da empresa.

## 17. Exemplo mínimo

### 17.1 Validar acesso

```http
POST /api/v1/assistente/acesso/validar
Authorization: Bearer <ZAPERP_API_TOKEN>
Content-Type: application/json
```

```json
{
  "telefone": "5534991847800"
}
```

### 17.2 Consultar produto

```http
POST /api/v1/assistente/produtos/consultar
Authorization: Bearer <ZAPERP_API_TOKEN>
Content-Type: application/json
```

```json
{
  "telefone": "5534991847800",
  "busca": "CHAPA DESLIZANTE"
}
```

Depois desses testes básicos, avançar para consultas de clientes e para o fluxo completo de orçamento.

## 18. Checklist de homologação

Antes de liberar a integração em produção, validar pelo menos:

1. Bearer válido do ZapERP;
2. Bearer ausente/inválido retorna `401`;
3. contato autorizado;
4. contato não autorizado retorna `403`;
5. consulta de produto por busca;
6. consulta de produto por código;
7. tratamento de produto ambíguo;
8. consulta de cliente;
9. tratamento de cliente ambíguo;
10. tratamento de vendedor ambíguo;
11. preparação de orçamento;
12. apresentação da prévia;
13. criação somente após confirmação;
14. retry da mesma operação com o mesmo `comando_id`;
15. proteção contra duplicidade;
16. tratamento de `RESULTADO_INCERTO`;
17. tratamento de alteração de dados entre preparar e criar;
18. comportamento com Sincronizador offline;
19. tratamento de timeout;
20. credencial não exposta no frontend ou logs.

## 19. Arquivos complementares

Utilizar este guia junto com:

```text
openapi.yaml
04-contratos-api.md
09-seguranca.md
01-identidade-e-isolamento.md
14-normalizacao-telefones.md
```

| Arquivo | Finalidade |
|---|---|
| `openapi.yaml` | contrato HTTP e schemas |
| `04-contratos-api.md` | regras funcionais e fluxos |
| `09-seguranca.md` | autenticação, autorização e segurança |
| `01-identidade-e-isolamento.md` | identidade e isolamento entre empresas |
| `14-normalizacao-telefones.md` | normalização e equivalência de telefone |
| `Integracao-ZapERP-API-WM.md` | guia específico de implementação |

## 20. Regra de precedência

Em caso de dúvida:

```text
1. openapi.yaml
2. documentação técnica específica
3. este guia
```

Se algum exemplo deste documento divergir do schema vigente no `openapi.yaml`, usar o contrato do `openapi.yaml`.

## 21. Dados fornecidos separadamente pela WM

A WM fornecerá por canal seguro:

```text
Base URL do ambiente
ZAPERP_API_TOKEN
```

O valor real da credencial não faz parte desta documentação.
