# API HelpDesk — Integração Icthus

## 1. Objetivo

Esta API permite que o Icthus:

- abra chamados no HelpDesk do ZapERP;
- liste apenas os chamados do CNPJ autenticado;
- consulte os detalhes de um chamado do mesmo CNPJ;
- envie mensagens em um chamado do mesmo CNPJ.

As operações administrativas de alteração e transferência continuam restritas aos usuários autenticados no ZapERP.

## 2. URL base

```text
Produção: https://<host-da-api-zaperp>/api/helpdesk
Local:    http://localhost:3000/api/helpdesk
```

Utilize sempre o prefixo `/api/helpdesk` na integração do Icthus.

## 3. Autenticação

Todas as requisições do Icthus devem enviar:

```http
X-HelpDesk-Token: <token-de-integracao>
X-Icthus-CNPJ: 12.345.678/0001-90
```

O CNPJ também pode ser enviado somente com números:

```http
X-Icthus-CNPJ: 12345678000190
```

O ZapERP normaliza o valor para `12.345.678/0001-90`.

### Regras de segurança

- o token deve permanecer em configuração protegida;
- não gravar o token no repositório, em logs ou mensagens de erro;
- não colocar o token diretamente em código JavaScript ou em uma DLL distribuída sem proteção;
- utilizar HTTPS em produção;
- o backend do Icthus deve preencher `X-Icthus-CNPJ` a partir do cliente autenticado, nunca de um valor livre informado pelo usuário;
- o CNPJ do cabeçalho define a identidade do cliente e prevalece sobre qualquer `cnpj` enviado no JSON.

## 4. Permissões

| Operação | Icthus | ZapERP |
|---|---:|---:|
| Criar chamado | Sim | Não |
| Listar chamados | Somente do CNPJ | Todos da empresa WM |
| Consultar detalhe | Somente do CNPJ | Sim |
| Enviar mensagem | Somente no chamado do CNPJ | Sim |
| Enviar nota interna | Não | Sim |
| Alterar status/prioridade/departamento | Não | Sim |
| Assumir chamado | Não | Usuário autenticado da Central |
| Transferir chamado | Não | Usuário autenticado da Central |

## 5. Valores aceitos

Antes de publicar esta versão da API, execute no Supabase o script:

```text
scripts/aplicar_helpdesk_dados_ambiente.sql
```

Ele adiciona de forma idempotente as colunas `sistema_operacional`, `nome_maquina` e `versao_sistema` à tabela `helpdesk_tickets`.

### Prioridade

```text
baixa
normal
alta
urgente
```

Quando não informada, a prioridade será `normal`.

### Status

```text
aberto
em_atendimento
resolvido
```

Todo chamado é criado inicialmente como `aberto`.

## 6. Criar chamado

```http
POST /api/helpdesk/tickets
```

### Headers

```http
Content-Type: application/json
X-HelpDesk-Token: <token>
X-Icthus-CNPJ: 12.345.678/0001-90
```

### Body

```json
{
  "titulo": "Erro ao emitir NF-e",
  "descricao": "A transmissão da nota fiscal retorna erro.",
  "empresa_nome": "Cliente Icthus Teste Ltda",
  "solicitante_nome": "Maria Cliente",
  "departamento": "Suporte",
  "telefone": "(11) 99999-9999",
  "sistema_operacional": "Windows 11 Pro",
  "nome_maquina": "FINANCEIRO-01",
  "versao_sistema": "Icthus 4.12.3",
  "prioridade": "alta"
}
```

Campos obrigatórios:

- `titulo`: até 180 caracteres;
- `descricao`: até 10.000 caracteres;
- `empresa_nome`: até 180 caracteres;
- `solicitante_nome`: até 180 caracteres;
- `departamento`: nome exato de um departamento existente na WM, por exemplo `Suporte`.

Campos opcionais:

- `telefone`: até 30 caracteres;
- `sistema_operacional`: até 120 caracteres;
- `nome_maquina`: até 120 caracteres;
- `versao_sistema`: até 120 caracteres;
- `prioridade`: padrão `normal`.

O campo `cnpj` não precisa ser enviado no body. O backend utiliza exclusivamente `X-Icthus-CNPJ` para identificar o cliente.

### Resposta — `201 Created`

```json
{
  "id": 123,
  "company_id": 1,
  "titulo": "Erro ao emitir NF-e",
  "descricao": "A transmissão da nota fiscal retorna erro.",
  "empresa_nome": "Cliente Icthus Teste Ltda",
  "cnpj": "12.345.678/0001-90",
  "solicitante_nome": "Maria Cliente",
  "telefone": "(11) 99999-9999",
  "sistema_operacional": "Windows 11 Pro",
  "nome_maquina": "FINANCEIRO-01",
  "versao_sistema": "Icthus 4.12.3",
  "prioridade": "alta",
  "status": "aberto",
  "cliente_id": null,
  "departamento": "Suporte",
  "responsavel_id": null,
  "criado_por": null,
  "atualizado_por": null,
  "atribuido_em": null,
  "criado_em": "2026-08-13T15:30:00.000Z",
  "atualizado_em": "2026-08-13T15:30:00.000Z"
}
```

## 7. Listar chamados do cliente

```http
GET /api/helpdesk/tickets
```

O backend sempre limita a consulta ao CNPJ de `X-Icthus-CNPJ`.

### Parâmetros opcionais

| Parâmetro | Descrição | Exemplo |
|---|---|---|
| `page` | Página, iniciando em 1 | `1` |
| `limit` | Itens por página, máximo 100 | `25` |
| `status` | Status do chamado | `aberto` |
| `prioridade` | Prioridade | `alta` |
| `q` | Pesquisa parcial em empresa/CNPJ, com ou sem máscara | `12345678000190` |
| `data_inicio` | Data inicial | `2026-08-01` |
| `data_fim` | Data final | `2026-08-31` |

Exemplo:

```http
GET /api/helpdesk/tickets?page=1&limit=25&status=aberto
```

### Resposta — `200 OK`

```json
{
  "items": [
    {
      "id": 123,
      "company_id": 1,
      "titulo": "Erro ao emitir NF-e",
      "descricao": "A transmissão da nota fiscal retorna erro.",
      "empresa_nome": "Cliente Icthus Teste Ltda",
      "cnpj": "12.345.678/0001-90",
      "solicitante_nome": "Maria Cliente",
      "telefone": "(11) 99999-9999",
      "sistema_operacional": "Windows 11 Pro",
      "nome_maquina": "FINANCEIRO-01",
      "versao_sistema": "Icthus 4.12.3",
      "prioridade": "alta",
      "status": "aberto",
      "departamento": "Suporte",
      "responsavel_id": 7,
      "responsavel_nome": "Felipe Suporte",
      "criado_em": "2026-08-13T15:30:00.000Z",
      "atualizado_em": "2026-08-13T15:30:00.000Z"
    }
  ],
  "page": 1,
  "limit": 25,
  "total": 1
}
```

## 8. Consultar chamado

```http
GET /api/helpdesk/tickets/{ticketId}
```

Exemplo:

```http
GET /api/helpdesk/tickets/123
```

O chamado somente será retornado quando pertencer ao CNPJ enviado no cabeçalho.

### Resposta — `200 OK`

```json
{
  "id": 123,
  "company_id": 1,
  "titulo": "Erro ao emitir NF-e",
  "descricao": "A transmissão da nota fiscal retorna erro.",
  "empresa_nome": "Cliente Icthus Teste Ltda",
  "cnpj": "12.345.678/0001-90",
  "solicitante_nome": "Maria Cliente",
  "telefone": "(11) 99999-9999",
  "sistema_operacional": "Windows 11 Pro",
  "nome_maquina": "FINANCEIRO-01",
  "versao_sistema": "Icthus 4.12.3",
  "prioridade": "alta",
  "status": "em_atendimento",
  "departamento": "Suporte",
  "responsavel_id": 7,
  "mensagens": [
    {
      "id": 501,
      "company_id": 1,
      "ticket_id": 123,
      "autor_usuario_id": null,
      "mensagem": "O problema continua acontecendo.",
      "interna": false,
      "criado_em": "2026-08-13T15:40:00.000Z"
    }
  ],
  "transferencias": []
}
```

Regras:

- notas internas nunca são retornadas ao Icthus;
- o histórico administrativo de transferências nunca é retornado ao Icthus;
- chamado de outro CNPJ retorna `404`.

## 9. Enviar mensagem

```http
POST /api/helpdesk/tickets/{ticketId}/messages
```

### Body

```json
{
  "mensagem": "O problema continua após uma nova tentativa."
}
```

`mensagem` é obrigatória e aceita até 10.000 caracteres.

Se o Icthus enviar `"interna": true`, o backend substituirá o valor por `false`.

### Resposta — `201 Created`

```json
{
  "id": 501,
  "company_id": 1,
  "ticket_id": 123,
  "autor_usuario_id": null,
  "mensagem": "O problema continua após uma nova tentativa.",
  "interna": false,
  "criado_em": "2026-08-13T15:40:00.000Z"
}
```

## 10. Rotas não permitidas ao Icthus

Estas rotas exigem o JWT de um usuário do ZapERP:

```http
POST  /api/helpdesk/tickets/{ticketId}/assume
PATCH /api/helpdesk/tickets/{ticketId}
POST  /api/helpdesk/tickets/{ticketId}/transfer
```

O token de integração do Icthus não concede acesso administrativo.

## 11. Erros HTTP

| Código | Situação |
|---:|---|
| `400` | Body inválido, campo obrigatório ausente ou CNPJ inválido |
| `401` | Token ausente ou inválido |
| `404` | Chamado inexistente ou pertencente a outro CNPJ |
| `429` | Limite de requisições excedido |
| `500` | Erro interno, banco indisponível ou integração mal configurada |

Formato padrão:

```json
{
  "error": "Descrição do erro"
}
```

Erros específicos de autenticação:

```json
{ "error": "Token de integracao nao informado" }
```

```json
{ "error": "Token de integracao invalido" }
```

```json
{ "error": "X-Icthus-CNPJ deve conter 14 digitos" }
```

## 12. Exemplo C# para a DLL

O exemplo abaixo utiliza APIs disponíveis no .NET 6 ou superior (`System.Net.Http.Json`). Para DLLs em .NET Framework, mantenha o mesmo contrato HTTP e substitua apenas a serialização JSON pela biblioteca adotada no Icthus.

```csharp
using System.Net.Http.Json;
using System.Text.Json;

public sealed class ZapErpHelpDeskClient
{
    private readonly HttpClient _http;
    private readonly string _integrationToken;

    public ZapErpHelpDeskClient(
        HttpClient http,
        string apiBaseUrl,
        string integrationToken)
    {
        _http = http;
        _http.BaseAddress = new Uri(apiBaseUrl.TrimEnd('/') + "/api/helpdesk/");
        _integrationToken = integrationToken;
    }

    private HttpRequestMessage CreateRequest(
        HttpMethod method,
        string url,
        string cnpj)
    {
        var request = new HttpRequestMessage(method, url);
        request.Headers.Add("X-HelpDesk-Token", _integrationToken);
        request.Headers.Add("X-Icthus-CNPJ", cnpj);
        return request;
    }

    public async Task<HelpDeskTicket> CriarChamadoAsync(
        string cnpj,
        CriarChamadoRequest body,
        CancellationToken cancellationToken = default)
    {
        using var request = CreateRequest(HttpMethod.Post, "tickets", cnpj);
        request.Content = JsonContent.Create(body);
        using var response = await _http.SendAsync(request, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
        return (await response.Content.ReadFromJsonAsync<HelpDeskTicket>(
            cancellationToken: cancellationToken))!;
    }

    public async Task<HelpDeskListResponse> ListarChamadosAsync(
        string cnpj,
        int page = 1,
        int limit = 25,
        CancellationToken cancellationToken = default)
    {
        using var request = CreateRequest(
            HttpMethod.Get,
            $"tickets?page={page}&limit={limit}",
            cnpj);
        using var response = await _http.SendAsync(request, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
        return (await response.Content.ReadFromJsonAsync<HelpDeskListResponse>(
            cancellationToken: cancellationToken))!;
    }

    public async Task<HelpDeskTicketDetail> ObterChamadoAsync(
        string cnpj,
        long ticketId,
        CancellationToken cancellationToken = default)
    {
        using var request = CreateRequest(HttpMethod.Get, $"tickets/{ticketId}", cnpj);
        using var response = await _http.SendAsync(request, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
        return (await response.Content.ReadFromJsonAsync<HelpDeskTicketDetail>(
            cancellationToken: cancellationToken))!;
    }

    public async Task<HelpDeskMessage> EnviarMensagemAsync(
        string cnpj,
        long ticketId,
        string mensagem,
        CancellationToken cancellationToken = default)
    {
        using var request = CreateRequest(
            HttpMethod.Post,
            $"tickets/{ticketId}/messages",
            cnpj);
        request.Content = JsonContent.Create(new { mensagem });
        using var response = await _http.SendAsync(request, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
        return (await response.Content.ReadFromJsonAsync<HelpDeskMessage>(
            cancellationToken: cancellationToken))!;
    }

    private static async Task EnsureSuccessAsync(
        HttpResponseMessage response,
        CancellationToken cancellationToken)
    {
        if (response.IsSuccessStatusCode) return;
        var content = await response.Content.ReadAsStringAsync(cancellationToken);
        throw new HttpRequestException(
            $"HelpDesk retornou {(int)response.StatusCode}: {content}",
            null,
            response.StatusCode);
    }
}

public sealed record CriarChamadoRequest(
    string titulo,
    string descricao,
    string empresa_nome,
    string solicitante_nome,
    string departamento,
    string? telefone = null,
    string? sistema_operacional = null,
    string? nome_maquina = null,
    string? versao_sistema = null,
    string prioridade = "normal");

public sealed record HelpDeskTicket(
    long id,
    int company_id,
    string titulo,
    string descricao,
    string empresa_nome,
    string cnpj,
    string solicitante_nome,
    string? telefone,
    string? sistema_operacional,
    string? nome_maquina,
    string? versao_sistema,
    string prioridade,
    string status,
    string departamento,
    int? responsavel_id,
    string? responsavel_nome,
    DateTimeOffset criado_em,
    DateTimeOffset atualizado_em);

public sealed record HelpDeskMessage(
    long id,
    int company_id,
    long ticket_id,
    int? autor_usuario_id,
    string mensagem,
    bool interna,
    DateTimeOffset criado_em);

public sealed record HelpDeskListResponse(
    IReadOnlyList<HelpDeskTicket> items,
    int page,
    int limit,
    int total);

public sealed record HelpDeskTicketDetail(
    long id,
    int company_id,
    string titulo,
    string descricao,
    string empresa_nome,
    string cnpj,
    string solicitante_nome,
    string? telefone,
    string? sistema_operacional,
    string? nome_maquina,
    string? versao_sistema,
    string prioridade,
    string status,
    string departamento,
    int? responsavel_id,
    DateTimeOffset criado_em,
    DateTimeOffset atualizado_em,
    IReadOnlyList<HelpDeskMessage> mensagens,
    IReadOnlyList<object> transferencias);
```

### Inicialização

```csharp
var httpClient = new HttpClient
{
    Timeout = TimeSpan.FromSeconds(30)
};

var helpDesk = new ZapErpHelpDeskClient(
    httpClient,
    "https://<host-da-api-zaperp>",
    configuration["ZapErp:HelpDeskToken"]!);
```

## 13. Checklist de integração

- [ ] URL de produção confirmada;
- [ ] token configurado fora do código-fonte;
- [ ] CNPJ obtido do cliente autenticado no Icthus;
- [ ] timeout configurado;
- [ ] tratamento de `400`, `401`, `404`, `429` e `500`;
- [ ] criação validada;
- [ ] isolamento entre dois CNPJs validado;
- [ ] consulta de detalhe validada;
- [ ] envio de mensagem validado;
- [ ] logs sem token de integração.
