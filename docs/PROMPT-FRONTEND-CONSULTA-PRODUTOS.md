Você é um desenvolvedor frontend sênior especialista em React, UX para atendimento em tempo real e painéis SaaS multiempresa.

Implemente no frontend do ZapERP um painel lateral/modal de **Consulta de Produtos** para uso dentro da tela de atendimento, sem poluir a experiência da conversa.

## Objetivo

Permitir que atendentes consultem rapidamente produtos, estoque e preço durante o atendimento, com busca rápida e experiência premium.

## Regras de negócio (obrigatórias)

- O backend já aplica JWT e isolamento por empresa (`company_id`) no servidor.
- O frontend **não** deve enviar `company_id` manualmente para atendente comum.
- Respeitar permissões por perfil:
  - `atendente`: pode consultar produtos.
  - `supervisor`: pode consultar produtos e ver status da sincronização.
  - `admin`: pode consultar produtos, ver status e disparar sincronização manual.

## Endpoints disponíveis

### 1) Consulta de produtos

- Método: `GET`
- URL: `/api/produtos/consulta`
- Query params:
  - `q` (string, opcional): termo de busca parcial
  - `somenteComEstoque` (boolean, opcional): `true` ou `false`
  - `limit` (number, opcional): padrão `50`, máximo `100`
  - `offset` (number, opcional): padrão `0`

Exemplo:

`GET /api/produtos/consulta?q=cimento&somenteComEstoque=true&limit=50&offset=0`

Resposta de sucesso:

```json
{
  "items": [
    {
      "codigoItem": "123",
      "descricaoItem": "CIMENTO CP II 50KG",
      "estoquePrevisto": 24,
      "precoUnitario": 39.9,
      "codigoFabricante": "ABC123",
      "codigoBarras": "7890000000000",
      "codigoSaida": "123",
      "ultimaSincronizacao": "2026-04-29T18:00:00.000Z"
    }
  ],
  "pagination": {
    "limit": 50,
    "offset": 0,
    "total": 100
  }
}
```

### 2) Status da sincronização

- Método: `GET`
- URL: `/api/produtos/sync/status`
- Perfis: `supervisor` e `admin`

Resposta:

```json
{
  "enabled": true,
  "running": false,
  "lastSyncStartedAt": "2026-04-29T17:30:00.000Z",
  "lastSyncFinishedAt": "2026-04-29T17:31:10.000Z",
  "lastSyncStatus": "success",
  "lastError": null,
  "intervalMinutes": 30
}
```

### 3) Disparo manual de sincronização (admin)

- Método: `POST`
- URL: `/api/produtos/sync/wm`
- Perfil: `admin`

Resposta:

```json
{
  "status": "success",
  "totalLidos": 1000,
  "totalInseridos": 200,
  "totalAtualizados": 800,
  "inicio": "2026-04-29T17:30:00.000Z",
  "fim": "2026-04-29T17:31:10.000Z",
  "erro": null
}
```

Quando já houver sincronização em execução:
- HTTP `409`
- `{ "error": "Sincronização já está em andamento." }`

## Requisitos de UX/UI

- Abrir como **painel lateral** (drawer) ou **modal largo** dentro da conversa.
- Layout limpo e profissional:
  - topo com busca + filtro `somenteComEstoque`
  - bloco de status da sincronização (para supervisor/admin)
  - lista em tabela ou cards com foco em legibilidade
- Destaques visuais:
  - `estoquePrevisto` em badge de cor (alto/médio/baixo/zerado)
  - `precoUnitario` com destaque e formatação de moeda (`pt-BR`)
- Ações por item:
  - botão **Copiar** dados do produto
  - botão **Enviar para conversa** (preencher caixa de mensagem com template)

## Estados de loading e erro

- Loading inicial: skeleton na lista.
- Loading de nova busca/paginação: spinner leve sem travar tela toda.
- Sem resultados:
  - mostrar estado vazio amigável com CTA para ajustar busca.
- Erro de consulta:
  - exibir alert amigável:
    - `"Não foi possível consultar produtos agora. Tente novamente."`
- Erro de sync/status:
  - manter a consulta funcionando
  - mostrar erro somente no card de sincronização.

## Comportamento de busca e paginação

- Debounce de busca: `300ms` a `500ms`.
- Se `q` vazio, carregar primeiros produtos ativos.
- Paginação server-side usando `limit` e `offset`.
- Evitar buscar sem necessidade (cache curto por query/filtro/página).

## Qualidade e segurança no frontend

- Sempre enviar `Authorization: Bearer <token>`.
- Não exibir detalhes técnicos de falha de infraestrutura.
- Não salvar dados sensíveis em localStorage além do necessário.
- Componentes responsivos para resoluções menores.

## Entregáveis esperados do frontend

- Componente de painel de consulta de produtos.
- Serviço/API client para os 3 endpoints.
- Estados de loading/erro/sucesso.
- Integração com tela de atendimento sem quebrar UX atual.
- Permissões por perfil no frontend.
