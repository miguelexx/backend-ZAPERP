# 36 — Orçamento manual ZapERP × API WM (plano de registro)

> **Substitui** a auditoria avulsa de 20/10/2026. Aquele texto estava arquiteturalmente certo,
> mas continha 6 afirmações imprecisas sobre o ZapERP e não via 8 pontos de integração reais.
> Este documento é a versão verificada contra o código em 20/10/2026 e é o único que vale.
>
> **Natureza:** análise estática + desenho. Nada implementado. Nenhuma migration aplicada,
> nenhuma chamada à API WM, nenhum commit, nenhum deploy.

## 0. Como usar este documento

Leia a seção 2 (decisões fechadas) e a seção 8 (o que não tocar) **antes** de abrir qualquer arquivo.
Cada sessão da seção 9 é autossuficiente: entrega, arquivos novos, arquivos tocados, testes e
critério de pronto. As sessões são **sequenciais** — nenhuma começa antes de a anterior fechar.

### Status de validação

| Uso | Status |
|---|---|
| Planejamento e estimativa | **aprovado** |
| Fundação desligada + leitura com mock | **aprovado com testes** |
| Preparação sem escrita em homologação | **aprovado** — a prévia usa o shape documentado (§8 da 2ª remessa); falta conferência humana contra o Icthus |
| Criação real no ERP | **bloqueado só na Sessão 6** (o despacho não existe). As pendências 1 e 2 foram **respondidas** em 20/10 e já estão traduzidas em código |
| Produção multiempresa | **bloqueado** na pendência **13** — a WM declara que *não* fornece prova de vínculo de tenant; o isolamento é 100% do ZapERP |

### Contrato recebido (20/10/2026)

Os 6 documentos da WM estão versionados em [`../wm/`](../wm/README.md) — `openapi.yaml`,
`04-contratos-api.md`, `09-seguranca.md`, `01-identidade-e-isolamento.md`,
`14-normalizacao-telefones.md` e `Integracao-ZapERP-API-WM.md`. Precedência declarada pela própria
WM: `openapi.yaml` → documentação técnica → guia.

**2ª remessa (20/10/2026, mais tarde no mesmo dia).** A WM enviou `openapi.yaml` atualizado — o
anterior ficou preservado como `openapi-2026-10-20-v1.yaml` — e o guia
`Integracao-ZapERP-API-WM-Atualizacao-2026-10-20.docx` (com extração em `.txt` ao lado, para busca).
Essa remessa **fechou as pendências 1 e 2**, que eram as duas que travavam a criação: §8 publica o
shape da prévia `pronto_para_confirmacao`, §8.1 fixa o campo de preço, §9.2 dá o mapeamento
obrigatório prévia → criação, §10 publica o `200` de `/orcamentos/criar` e §11.1 declara que o
contrato **não** distingue "criado agora" de "resultado idempotente". Também publicou a base de
produção (§2) e acrescentou o erro `ORCAMENTO_DADOS_ALTERADOS` (§11).

Das 14 pendências da seção 10, hoje: **6 respondidas (1, 2, 4, 9, 11, 12), 3 parciais (3, 8, 10) e
5 abertas (5, 6, 7, 13, 14)** — nenhuma das abertas trava a criação; elas travam a **produção**.
Status item por item na seção 10. (A contagem anterior, "5 respondidas, 4 parciais e 4 abertas",
estava errada: as 13 linhas da tabela eram 3 🟢 / 4 🟡 / 6 🔴.)

Os documentos foram escritos tendo o **n8n/WhatsApp como consumidor principal**. O ZapERP é o
segundo consumidor, com credencial própria, e faz o mesmo fluxo por interface gráfica com estado no
servidor. Onde o texto descreve comportamento de chatbot ("numeração local 1–30",
"MAIS/ANTERIOR", preservar contexto entre mensagens), leia como **requisito funcional**, não como
desenho de tela: o desenho do ZapERP é a seção 9.

---

## 1. O que vamos construir

Orçamento **100% manual** iniciado de dentro de uma conversa individual do Atendimento. O atendente
pesquisa o cliente do ERP por nome, informa o vendedor, digita produtos por palavras comuns
("celular", "notebook"), escolhe entre os semelhantes, informa quantidades, revisa a prévia
calculada pela WM e só então confirma a gravação.

```
Navegador ZapERP ──JWT──▶ Backend ZapERP ──HTTPS + ZAPERP_API_TOKEN──▶ API WM ──▶ Worker ──▶ SQL Server/Icthus
                          · company_id só do JWT
                          · resolve o telefone autorizado no servidor
                          · guarda a preparação e o comando_id
```

O navegador **nunca** recebe nem envia: `ZAPERP_API_TOKEN`, base URL da WM, telefone autorizado,
`company_id`/`empresa_id`/`sincronizador_id` como seletor de tenant, `comando_id`, ou o preço usado
na criação.

### O telefone que não é o da conversa

Nos endpoints WM, `telefone` é o **contato autorizado que resolve a instalação/empresa** — não o
comprador. Confundir os dois é o maior risco de isolamento desta integração. O telefone da conversa
jamais vai para a WM como `telefone`.

### Sem IA, nunca

| O usuário decide | O sistema faz |
|---|---|
| cliente, vendedor, produto de cada item, quantidade | consulta, valida, calcula, mostra e grava |

O sistema não lê a conversa para adivinhar produtos, não sugere com IA, não escolhe sozinho, não
inventa quantidade, não altera preço do ERP e não cria nem envia nada sem clique explícito.
Preço e totais oficiais vêm da preparação/revalidação WM; o frontend só exibe.

---

## 2. Decisões fechadas

Dez decisões que simplificam o desenho original. Todas justificadas pelo código existente.
**Não reabrir sem motivo novo.**

### D1 — Sem criptografia de aplicação. Coluna em texto, nunca exposta.

A auditoria original propunha `telefone_autorizado_ciphertext`, `payload_criacao_ciphertext` e
`WM_INTEGRATION_ENCRYPTION_KEY`. **Rejeitado.** Não existe um único `createCipheriv` na codebase; a
prática da casa é segredo em coluna de texto que nunca sai em resposta — ver o comentário da
migration `20260904120000_whatsapp_instances_provider_whapi.sql:41`:
*"Segredo da API. (…) Nunca expor em respostas públicas."* O Bearer da WM fica no `.env`, não no
banco. Cifrar só o telefone, enquanto todo o resto está em texto, é teatro com risco operacional
real (chave para gerenciar, chave para perder, rotação para errar).

**Regra:** `telefone_autorizado text`, nunca retornado por nenhuma rota (só `telefone_ultimos4` para
exibição), nunca em log, nunca em auditoria. Se um dia houver cripto em repouso, é frente própria
para **todos** os segredos, não para este campo.

### D2 — Sem `GET /api/orcamentos/disponibilidade`. A flag viaja no `getMe`.

O padrão da casa para "módulo ligado por empresa" é coluna em `empresas` + helper com cache +
middleware fail-closed + flag no payload do usuário: `modulo_campanhas_ativo`
(`controllers/userController.js:20,:62`), `middleware/requireModuloCampanhas.js`,
`canAcessarDisparo` (`frontend/src/auth/permissions.js:120`), e `crm_habilitado` — que é env global
**E** flag por empresa (`controllers/userController.js:36`).

**Regra:** `orcamento_wm_habilitado` entra na resposta do `getMe` e do login, calculado como
`WM_ORCAMENTOS_ENABLED` (env, global) **E** `wm_orcamento_integracoes.ativo` da empresa. Zero
requisição extra ao abrir o drawer, zero chamada à WM para saber se o botão aparece.

### D3 — Sem rate limiter novo. `destructiveLimiter` já existe.

`destructiveLimiter` (300/min, `middleware/rateLimit.js:92`) é o limiter certo para `confirmar`.
Busca e preparação ficam no `apiLimiter` do mount. A proteção real de concorrência não é rate
limit — é a transição atômica de estado no banco (seção 7).

### D4 — Um hash, não dois payloads. Sem `request_fingerprint` separado.

`payload_criacao jsonb` (o payload exato, para replay) + `payload_hash text` (SHA-256 do JSON
canônico). O hash basta para detectar "mesmo `comando_id`, payload diferente". Sem coluna de
ciphertext, sem duplicação.

### D5 — `wmApiClient` espelha `services/providers/whapi/http.js`.

Não inventar cliente HTTP. O arquivo do Whapi já resolve e **já está certo** no ponto mais
perigoso: `helpers/retryWithBackoff.fetchWithRetry` usa `maxAttempts = 1` para método não
idempotente, a menos que se opte explicitamente por retry (`helpers/retryWithBackoff.js:58-61`).

| Chamada WM | Como chamar | Por quê |
|---|---|---|
| `produtos/consultar` | `retryOpts: { idempotent: true }` | leitura; 5xx/429/408 podem repetir |
| `orcamentos/preparar` | `retryOpts: { retryConnectionErrors: true }` | POST sem escrita; só erro de conexão repete |
| `orcamentos/criar` | **`retryOpts` omitido** → 1 tentativa | timeout ou resposta ambígua NUNCA repete |

Node 24 → `fetch`, `AbortSignal.timeout` e `crypto.randomUUID` nativos. Nenhuma dependência nova.

### D6 — Migration só em `supabase/migrations/`.

Existem dois diretórios: `migrations/` (132 arquivos) e `supabase/migrations/` (135),
dessincronizados em 3 arquivos. `docs/AI_HANDOFF.md:155` é explícito:
**"Fonte normativa: `supabase/migrations/`"**. A migration nova vai só lá.
**Não tocar em `migrations/`** — está defasado e não é problema desta frente.

### D7 — Códigos de permissão pontilhados, e um `requirePermissao` único.

`/me/permissoes` devolve um mapa cujas chaves são os `codigo` do catálogo
(`controllers/permissoesController.js:119-122`), que são pontilhados (`disparo.ver`). O frontend hoje
consulta `dashboard_acessar`, `config_acessar`, `usuarios_acessar`
(`frontend/src/auth/permissions.js:13-19`) — chaves que **não existem no catálogo**, então caem no
fallback por role e o gate real desaparece. Não repetir o bug.

Também **não existe** middleware `requirePermissao(codigo)` para reutilizar: só `adminOnly`,
`supervisorOrAdmin` e `requireModuloCampanhas`; `usuarioTemPermissao` é chamado inline em apenas 2
controllers. A Sessão 2 cria o middleware genérico — uma vez, bem feito.

| Código | Padrão |
|---|---|
| `orcamentos.ver` | admin, supervisor, atendente |
| `orcamentos.criar` | admin, supervisor, atendente (com override) |
| `orcamentos.ver_historico_empresa` | admin, supervisor |

`orcamentos.configurar` **não entra no catálogo** no MVP: o vínculo com o telefone WM é provisionado
por operação confiável, não por admin de tenant (seção 4).

### D8 — "Novo orçamento" é ação e componente separados. Não é aba do drawer de produtos.

**Esta é a correção mais importante para não quebrar nada.** A auditoria original dizia que o drawer
de produtos abre "dentro de conversa individual". Falso: ele é montado em **dois** lugares —
`frontend/src/conversa/components/ConversaHeader.jsx:139` e também
`frontend/src/chats/chatList.jsx:2112`, a partir de `ChatListHeaderBar`, **sem conversa aberta e sem
o guarda `!isGroup`**. Transformar aquele drawer em `Produtos | Novo orçamento` colocaria a aba de
orçamento num contexto sem `conversa_id`.

**Regra:** `ProdutoConsultaPanel` fica intacto, nos dois lugares. "Novo orçamento" é um botão novo
**só** no `ConversaHeader`, com o mesmo guarda do produtos (`!isGroup && conversaId`) mais o gate do
módulo, abrindo um componente novo em `frontend/src/conversa/orcamento/`.

### D9 — Reusar `assertPermissaoConversa`. Não re-derivar acesso.

`services/chat/access/conversationPolicy.js → assertPermissaoConversa({ company_id, conversa_id, user_id, role, user_dep_ids })`
é a política canônica, usada por 10 controllers, e já cobre visibilidade por número
(`atendentePodeVerNumero`), setor, grupo por departamento, responsável e participante ativo.
Toda rota de orçamento que receba `conversa_id` chama essa função. Permissão de orçamento **não**
concede acesso a conversa de outro setor ou de outro número.

### D10 — Verificar um `INCERTO` é reenviar o mesmo payload com o mesmo `comando_id`.

**Revisado em 20/10 com o contrato em mãos.** Não existe endpoint de status, mas a verificação está
definida pela própria idempotência: o guia autoriza repetir a requisição com o **mesmo**
`comando_id` quando houve problema de transporte (§11), e declara que mesmo `comando_id` + operação
já concluída devolve o resultado idempotente **sem criar de novo** (§13). Logo, reenviar o payload
**byte a byte idêntico** com o mesmo `comando_id` é seguro e é a verificação oficial.

Três respostas possíveis, e nenhuma delas é "tentar de novo com UUID novo":

| Resposta | Significado | Estado local |
|---|---|---|
| `200` | já estava criado (ou criou agora) | `CRIADO` |
| `409 COMANDO_NAO_REEXECUTADO` / `RESULTADO_INCERTO` | em andamento ou ainda incerto; a WM **não** reexecuta | segue `INCERTO` |
| `409 COMANDO_ID_REUTILIZADO` | payload divergente do original | erro crítico local; nunca reenviar |

Por isso o `payload_criacao` precisa ser guardado exatamente como foi despachado (seção 6): sem ele
não há verificação possível. A ação é **sempre explícita** — botão do usuário ou operação de
suporte, nunca automática, nunca em loop (§12 proíbe repetir automaticamente). Um `INCERTO` que
responde 409 indefinidamente continua travando nova criação equivalente e vira runbook.

### D11 — Cliente e vendedor resolvem dentro de `preparar`. Não usar `/clientes/consultar`.

**Decisão nova de 20/10, tirada do contrato.** `/clientes/consultar` **não** filtra
`Inativo`/`Bloqueado`, mas `preparar` **filtra** (`04-contratos-api.md`, "Elegibilidade"). Um
cliente escolhido pelo primeiro pode ser recusado pelo segundo com `CLIENTE_INVALIDO` — um beco sem
saída que o atendente não tem como prever.

`preparar` já resolve cliente e vendedor por `cliente_busca` / `vendedor_busca`, com paginação de 30
e candidatos enriquecidos (cliente vem com `cpf`, `cnpj`, `inscricao_estadual`; vendedor com
`codigo_vendedor_erp` e `nome`). Então o MVP usa só:

```
/produtos/consultar  →  picker incremental de produto (sem preço; o contrato não traz)
/orcamentos/preparar →  resolve cliente + vendedor + itens, e devolve a prévia
/orcamentos/criar    →  grava
```

`/clientes/consultar` e `/acesso/validar` ficam fora do caminho do orçamento — `acesso/validar` só
em provisionamento e diagnóstico. Isso elimina a classe de erro acima, reduz o orçamento comum para
**2 a 5 chamadas** sem esforço extra, e tira um endpoint inteiro do escopo da Sessão 3.

---

## 3. Correções aplicadas à auditoria de 20/10

| Afirmação original | O que o código diz |
|---|---|
| O drawer de produtos abre só na conversa | Abre também na lista, sem `conversa_id` e sem guarda de grupo → D8 |
| "Reutilizar as permissões granulares por catálogo" do módulo de produtos | O módulo de produtos **não** usa catálogo: `canConsultarProdutos = ["admin","supervisor","atendente"].includes(userRole)` (`frontend/src/chats/chatList.jsx:207`); e `GET /api/produtos/consulta` tem **só `auth`**, nenhuma checagem de permissão (`routes/produtosRoutes.js`) |
| "Usar o mesmo predicado no menu e no backend" | Não há middleware de permissão para reutilizar → D7 cria |
| "Axios faz logout em qualquer 401 da API local" | Só se o request levou Bearer e sem `skipAuthLogout: true` (`frontend/src/api/http.js:117-121`). A recomendação (não espelhar o 401 da WM) continua válida, por outro motivo: o toast global (seção 3, lacuna 1) |
| Migration em `supabase/migrations/` (sem ressalva) | Há dois diretórios dessincronizados → D6 |
| `telefone_autorizado_ciphertext` + chave de 32 bytes | Não existe cripto na codebase → D1 |

### O que a auditoria acertou e fica valendo

`company_id` obrigatório e só do JWT (`middleware/auth.js:21-35`) · `auditoria_log.entidade_id` é
`integer` e não aceita UUID (migration `20260310000000…:72`) · `API_RATE_LIMIT_MAX` default
**30000/min** é amplo demais para proteger integração externa · timeout Axios de 55s
(`frontend/src/api/httpTimeouts.js:2`) · **zero** testes de produtos (0 de 233 arquivos em `tests/`) ·
produtos lê Postgres próprio, não a API WM · existe política canônica de conversa · a ordem de
Escape é fonte única com teste dedicado.

### Oito pontos de integração que faltavam

1. **O toast global contradiz "nenhum erro técnico ao usuário".** O interceptor exibe "Erro no
   servidor" para **todo** 5xx, "Muitas requisições" no 429 e "Demora na resposta" no timeout
   (`frontend/src/api/http.js:140-180`). O service novo tem de passar `skipGlobal500Toast`,
   `skipGlobalNetworkToast` e `skipGlobal403Toast` em **todas** as chamadas e tratar o erro na
   própria tela. É requisito, não detalhe.
2. **O timeout é resolvido por URL** em `resolveRequestTimeoutMs`
   (`frontend/src/api/httpTimeouts.js:62`) — é ali que `/api/orcamentos/*` se registra, não com um
   número solto no componente.
3. **`formatMoeda` do painel de produtos devolve `"R$ 0,00"` para valor inválido**
   (`frontend/src/conversa/ProdutoConsultaPanel.jsx:15-19`) — exatamente o fallback proibido. O
   orçamento tem o seu próprio formatador, que devolve `"—"`.
4. **`requireModuloCampanhas` + `crm_habilitado` são o precedente do gate por empresa** → D2.
5. **`destructiveLimiter` já existe** → D3.
6. **A sync atual é mono-empresa:** `WM_PRODUTOS_COMPANY_ID` default `'1'`
   (`services/produtosSyncService.js:147`). O cache de produtos tem dados de um tenant estampados
   com um `company_id` de variável de ambiente. Mais um motivo para não reaproveitar nada dele.
7. **O padrão TLS vizinho é o oposto do exigido:** `config/produtosDb.js:18` usa
   `ssl: { rejectUnauthorized: false }` e `config/wmSqlServer.js:23` tem `trustServerCertificate`
   default `true`. O cliente WM exige TLS verificado — quem copiar o vizinho erra.
8. **A ordem de Escape tem teste dedicado:** `frontend/scripts/test-conversa-escape-order.mjs`.
   Overlay novo sem atualizar o teste = teste vermelho.

---

## 4. Quatro identidades que não se misturam

| Identidade | Origem | Pode vir do navegador? |
|---|---|---|
| Usuário ZapERP | JWT verificado | sim, o JWT |
| Empresa ZapERP | `req.user.company_id` | **nunca** por body/query |
| Contato autorizado WM | config server-side da empresa | **não** |
| Cliente/comprador ERP | escolha manual por busca/código | busca e código sim; tenant nunca |

```
req.user.company_id → wm_orcamento_integracoes (mesma company_id) → telefone_autorizado → API WM
```

**Provisionamento.** O endpoint de validação da WM retorna só `{ "autorizado": true }` — prova que o
telefone é aceito, **não** que pertence à mesma empresa do `company_id` ZapERP. Enquanto for assim,
admin de tenant **não** cadastra esse telefone: o vínculo é provisionado por operação/suporte
confiável, conferido com a WM. Preferível: a WM evoluir o contrato para devolver uma identidade
opaca comparável com um vínculo previamente provisionado (seção 10, item 13).

Nunca "resolver" um `403` adicionando ou removendo o nono dígito em loop, e nunca usar o helper de
telefone do WhatsApp como fonte normativa desta autorização — a normalização brasileira é
centralizada na WM.

---

## 5. Contrato local (proposta; não existe hoje)

| Rota ZapERP | Body aceito do navegador |
|---|---|
| `POST /api/orcamentos/produtos/consultar` | `busca` XOR `codigo_produto_erp`, `pagina` |
| `POST /api/orcamentos/preparar` | `conversa_id`, cliente, vendedor, itens, páginas |
| `POST /api/orcamentos/:preparacaoId/confirmar` | corpo vazio |
| `POST /api/orcamentos/:operacaoId/verificar` | corpo vazio (D10) |
| `GET /api/orcamentos/:operacaoId` | — |

Não há rota de clientes: cliente e vendedor resolvem dentro de `preparar` (D11). Montagem em
`app.js` seguindo o padrão vizinho: `app.use('/orcamentos', apiLimiter, …)` e
`api.use('/orcamentos', …)`; o frontend usa **sempre** `/api/orcamentos/*`.

### Regras dos DTOs

Schemas estritos, `additionalProperties: false`. Rejeitar vindos do navegador: `company_id`,
`empresa_id`, `sincronizador_id`, `telefone`, `token`, `base_url`, `comando_id`, `preco_confirmado`.
Exatamente um de busca/código onde o contrato exigir. Nenhuma resposta ou erro da WM atravessa cru.

Limites extraídos do `openapi.yaml` — validar **localmente**, antes de gastar uma chamada:

| Campo | Limite do contrato |
|---|---|
| `itens` | 1 a 50 |
| `busca` de produto | 1 a 100 caracteres |
| `codigo_produto_erp` | 1 a **7** caracteres |
| `cliente_codigo_erp`, `vendedor_codigo_erp` | até **20** caracteres |
| `cliente_busca`, `vendedor_busca` | 1 a 100 caracteres |
| `pagina` (todas) | inteiro `>= 1`, máx. 2147483647; `tamanho_pagina` é fixo em 30 e **não pode ser enviado** |
| `quantidade` e `preco_confirmado` na criação | **string** casando `^\d+(?:\.\d+)?$` |
| `limite` em produtos | **obsoleto e ignorado** — não enviar |

Três regras que o contrato impõe e que são fáceis de violar sem perceber:

1. **Quantidade e preço são string decimal, sempre, nas duas chamadas.** `preparar` aceita
   `number` ou `string`; mandar `number` abre porta para desvio de float. E o padrão da criação
   **aceita `0`** — rejeitar quantidade zero é trabalho do validador local, não da WM.
2. **O preço vai copiado byte a byte.** A WM serializa preço como `0.00##` invariant (ex.: `33.038`,
   três decimais) e estoque como `0.000` (pode ser negativo, ex.: `-2.125`). Reformatar, arredondar
   ou passar por `Number` quebra a conferência na criação.
3. **Página fora do intervalo é `400 PAGINA_FORA_DO_INTERVALO`, sem clamp.** O contrato é explícito
   em não corrigir silenciosamente; a UI também não corrige — ela só oferece páginas que
   `tem_mais`/`tem_anterior` permitem.

### Envelope de erro

A WM devolve o código na chave **`erro`** (não `codigo`, não `error`): `{"erro": "SINCRONIZADOR_OFFLINE"}`,
e no `502` de `preparar` também `indice_item` zero-based. O mapeador local lê `erro` e produz o
envelope estável do ZapERP:

```json
{
  "ok": false,
  "codigo": "WM_SINCRONIZADOR_OFFLINE",
  "mensagem": "O ERP está indisponível no momento.",
  "estado": "FALHA_SEGURA",
  "requestId": "..."
}
```

Códigos nomeados nos documentos, para o mapeador: `TOKEN_ASSISTENTE_INVALIDO` (401) ·
`CONTATO_NAO_AUTORIZADO` (403) · `payload_invalido`, `PERIODO_INVALIDO`, `PAGINA_FORA_DO_INTERVALO`
(400) · `CLIENTE_INVALIDO`, `VENDEDOR_NAO_ENCONTRADO`, `PRODUTO_NAO_ENCONTRADO`, `PRODUTO_INATIVO`
(502, os dois últimos com `indice_item`) · `SINCRONIZADOR_OFFLINE` (503) · `REALTIME_TIMEOUT` (504) ·
`COMANDO_ID_REUTILIZADO`, `COMANDO_NAO_REEXECUTADO`, `RESULTADO_INCERTO` (409) ·
`ORCAMENTO_DADOS_ALTERADOS` (**HTTP não fixado pelo guia** — ver abaixo).
O mapeamento completo vive em `shared/http/errors.ts` da WM, que não recebemos — então o mapeador
precisa de um **ramo padrão** por faixa de HTTP para código desconhecido, nunca repassar cru.

`ORCAMENTO_DADOS_ALTERADOS` (§11 da 2ª remessa: os dados mudaram entre a prévia e a criação) é o
único código mapeado **por código e não por status**, de propósito: o guia o descreve sem fixar o
HTTP (a tabela dele põe recusa de ERP em `502` e conflito de comando em `409`), e o ramo padrão do
`409` marcaria `INCERTO` na criação. É recusa **antes** da escrita, logo `FALHA_SEGURA` e `409`
local — e a orientação ao usuário é **repreparar e confirmar de novo**, nunca "tentar de novo" com
o mesmo comando.

O `401` da WM **nunca** vira `401` local — viraria logout do atendente. Mapeia para `503` local com
código de domínio e alerta operacional.

Um `403` é ambíguo por desenho: pode ser contato inexistente/inativo **ou**
`CONFLITO_EQUIVALENCIA_TELEFONE` (dois contatos equivalentes cadastrados), e o diagnóstico da WM
omite o telefone de propósito. A mensagem ao usuário não deve afirmar qual dos dois é.

---

## 6. Persistência

Fonte normativa: `supabase/migrations/<timestamp>_wm_orcamentos.sql` (D6). Toda query filtra
`company_id` explicitamente — o cliente Supabase usa SERVICE_ROLE e ignora RLS.

### `wm_orcamento_integracoes`

`id` · `company_id` **UNIQUE** · `ativo` · `telefone_autorizado` (texto, nunca exposto — D1) ·
`telefone_ultimos4` · `validado_em` · `validacao_status` · `provisionado_por` · `criado_em` ·
`atualizado_em`.

### `wm_orcamento_operacoes`

`id` UUID (é o id da preparação) · `company_id` · `usuario_id` · `conversa_id` nullable · `estado` ·
`comando_id` UUID nullable **UNIQUE** · `payload_criacao` jsonb · `payload_hash` text ·
`previa_sanitizada` jsonb · `wm_resultado_sanitizado` jsonb · `http_status_ultimo` ·
`erro_codigo_ultimo` · `tentativas` · `expira_em` · `enviado_em` · `concluido_em` · `criado_em` ·
`atualizado_em`.

Índices: `(company_id, criado_em DESC)` · `(company_id, conversa_id, criado_em DESC)` ·
`UNIQUE(comando_id) WHERE comando_id IS NOT NULL` · `(company_id, estado)`.

**Retenção:** limpar preparações expiradas e `payload_criacao` após a janela de idempotência que a
WM informar (seção 10, item 5). CPF/CNPJ de candidatos **não selecionados** nunca são persistidos
nem logados.

### Auditoria

`auditoria_log.entidade_id` é `integer` e a operação é UUID. Usar `entidade = 'wm_orcamento'`,
`entidade_id = null` e o UUID em `detalhes_json.operacao_id`. Isso precisa de teste — a auditoria é
best-effort e um erro ali fica silencioso (`helpers/auditoriaLog.js:30`).

Eventos: `wm_orcamento_config_validada` · `wm_orcamento_preparado` · `wm_orcamento_confirmado` ·
`wm_orcamento_criado` · `wm_orcamento_resultado_incerto` · `wm_orcamento_falha_segura`.

**Nunca logar:** Bearer WM, telefone autorizado completo, body cru, CPF/CNPJ/IE, payload de criação
completo, resposta bruta de erro SQL/Worker, URL com segredo.

---

## 7. Idempotência e máquina de estados

O `comando_id` é gerado pelo **backend**, uma única vez por confirmação de negócio, e **persistido
antes** da chamada externa. O frontend não gera UUID. Duplo clique, duas abas, F5 ou timeout não
criam outro comando.

```
PREPARADO ──confirmação explícita (gera e persiste comando_id)──▶ ENVIANDO
   │                                                               ├─ 200 ────────────────────▶ CRIADO
   └── prazo local ──▶ EXPIRADO                                    ├─ recusa pré-escrita ────▶ FALHA_SEGURA
                                                                   └─ timeout / rede / 504 ──▶ INCERTO (terminal, D10)
```

### A trava de concorrência é o banco

```sql
UPDATE wm_orcamento_operacoes
   SET estado = 'ENVIANDO', comando_id = $uuid, enviado_em = now()
 WHERE id = $preparacao_id
   AND company_id = $jwt
   AND estado = 'PREPARADO'
   AND expira_em > now()
RETURNING *
```

Só uma requisição ganha a transição; as outras recebem o estado atual e **não** chamam a WM.

### Proteção do preço

O OpenAPI de criação exige `preco_confirmado` — se a UI devolvesse o preço, daria para adulterar no
DevTools. Quando `preparar` responder `pronto_para_confirmacao`, o backend guarda o payload exato de
criação em `payload_criacao`, calcula `payload_hash` e devolve à UI **apenas** um `preparacao_id`
opaco e a prévia sanitizada. No `confirmar`, preço e códigos vindos do navegador são **ignorados**.
Qualquer alteração em cliente, vendedor, produto, quantidade ou política invalida a preparação.

Se a preparação não devolver todos os campos exatos que `criar` exige, **isso é bloqueio de
contrato** (seção 10, itens 1, 2 e 9).

### Retry

| Cenário | Ação |
|---|---|
| falha antes de despacho comprovado | pode voltar a `PREPARADO` |
| `502` na criação (recusa pré-escrita) | `FALHA_SEGURA`; repreparar e nova confirmação |
| `503` antes do envio | sem retry automático; revalidar |
| `504` ou erro de rede após despacho | `INCERTO`; **não** gerar outro UUID |
| `200` idempotente para o mesmo comando | `CRIADO`, sem duplicar histórico |
| mesmo `comando_id` + `payload_hash` diferente | erro crítico local; nunca despachar |

---

## 8. O que não tocar

**Arquivos proibidos nestas sessões.** Qualquer necessidade de alterá-los é sinal de desenho errado:

- `frontend/src/conversa/ProdutoConsultaPanel.jsx` e os dois mounts dele (`chatList.jsx`,
  `ChatListHeaderBar.jsx`) — D8
- `frontend/src/api/produtosService.js`, `services/produtosService.js`, `services/produtosSyncService.js`,
  `config/produtosDb.js`, `config/wmSqlServer.js`
- `services/chat/access/conversationPolicy.js` — **chamar**, nunca editar
- `useAutoScroll` / `visualViewport` e as barras sticky (`.wa-selectBar`, `.wa-pinBar`)
- `backend/migrations/` (o diretório defasado — D6)
- lista virtualizada, composer e qualquer caminho de envio de mensagem

**Pontos de registro — exatamente estes, nada mais:**

| Arquivo | Alteração |
|---|---|
| `backend/app.js` | `require` + 2 linhas de mount (padrão das linhas 363 e 395) |
| `backend/helpers/permissoesCatalogo.js` | 3 entradas novas, pontilhadas (D7) |
| `backend/controllers/userController.js` | `orcamento_wm_habilitado` no `getMe` (~l. 20-62) e no login (~l. 458) — D2 |
| `backend/.env.example` | bloco `WM_ORCAMENTOS_*` |
| `frontend/src/api/httpTimeouts.js` | `/api/orcamentos/*` em `resolveRequestTimeoutMs` |
| `frontend/src/auth/permissions.js` | `canAcessarOrcamento` / `canCriarOrcamento`, modelados em `canAcessarDisparo` |
| `frontend/src/conversa/components/ConversaHeader.jsx` | botão "Novo orçamento" ao lado do de produtos (~l. 139) |
| `frontend/src/conversa/components/ConversaViewOverlays.jsx` | `lazy()` + mount do drawer (~l. 9 e 353) |
| `frontend/src/conversa/utils/conversationEscapeOrder.js` | `"orcamentoDrawer"` **e** `frontend/scripts/test-conversa-escape-order.mjs` |

---

## 9. Sessões

Sequenciais. Nenhuma começa antes de a anterior fechar.

### Sessão 0 — Fechar o contrato (sem código) — **parcialmente concluída em 20/10**

✅ Feito: os documentos das **duas** remessas estão versionados em [`../wm/`](../wm/README.md) e
lidos; 6 pendências respondidas, 3 parciais (seção 10). Os itens **1 e 2** — que eram os únicos a
travar a Sessão 6 — foram fechados pela 2ª remessa, junto do item **9**. A **base URL** de produção
também já veio (§2, HTTPS), e está no `.env.example` comentada.

⬜ Falta, e **só a WM pode fechar**: os itens **5, 6, 7 e 8** antes da produção; o item **14**
(divergência de `preco_negociado` entre OpenAPI e guia) antes de existir desconto por linha; e o
item **13** antes de qualquer segunda empresa. Também falta obter o **token** por canal seguro, as
fixtures da lista abaixo, e confirmar as versões implantadas da API WM e do Worker — note que
`04-contratos-api.md` exige rollout **Worker primeiro, API depois, consumidor por último**, então
uma API nova com Worker antigo não tem a paginação que o nosso desenho usa.

### Sessão 1 — Registro (sem código)

Este documento vira o 36 oficial; adicionar o ponteiro em `backend/docs/README.md` e a linha na
tabela de `docs/ai-handoff/00-LEIA-PRIMEIRO.md`.
**Pronto quando:** a próxima sessão acha tudo sem ler o chat.

### Sessão 2A — Fundação que não depende do contrato WM

**Pode começar antes da Sessão 0.** Nada aqui conhece um schema da WM: é só isolamento, gate por
empresa, permissão e persistência local.

**Novos:** `supabase/migrations/<ts>_wm_orcamentos.sql` (as 2 tabelas da seção 6) ·
`middleware/requirePermissao.js` · `middleware/requireOrcamentoWm.js` ·
`helpers/orcamentoWmFlag.js` (espelha `helpers/moduloCampanhas.js`, cache de 20s) ·
`services/wm/wmIntegrationConfigService.js` · `services/wm/wmOrcamentoStateMachine.js` ·
`tests/requirePermissao.test.js` · `tests/orcamentoWmFlag.test.js` ·
`tests/wmOrcamentoStateMachine.test.js`

**Tocados:** `helpers/permissoesCatalogo.js` (3 entradas — D7) · `controllers/userController.js`
(`orcamento_wm_habilitado` no `getMe` e no login — D2) · `.env.example` (bloco `WM_ORCAMENTOS_*`).
**Ainda não** mexer em `app.js`: sem rota montada, não há superfície exposta.

**Testes obrigatórios:** `requirePermissao` nega sem a permissão e aceita com override · admin passa
sempre (espelha `usuarioTemPermissao`) · `requireOrcamentoWm` é fail-closed em erro de leitura da
flag · a flag exige env global **E** empresa ativa · máquina de estados rejeita toda transição
inválida · `payload_hash` determinístico para o mesmo payload em ordem diferente de chaves ·
auditoria com `entidade = 'wm_orcamento'`, `entidade_id = null` e UUID em `detalhes_json` grava de
verdade · toda query das 2 tabelas tem `.eq('company_id', …)`.

**Pronto quando:** `WM_ORCAMENTOS_ENABLED=false`, nenhuma rota montada, suíte verde, migration
escrita e **não aplicada**.

### Sessão 2B — Cliente HTTP e DTOs (precisa da Sessão 0)

**Novos:** `services/wm/wmApiClient.js` (espelha `services/providers/whapi/http.js` — D5) ·
`helpers/wmErrorMapper.js` · `validators/wmOrcamentosValidators.js` · `tests/wmApiClient.test.js` ·
`tests/wmErrorMapper.test.js` · `tests/wmOrcamentosValidators.test.js`

**Tocados:** nenhum (o mount fica para a Sessão 3).

**Testes obrigatórios:** URL construída só a partir da base configurada · `Authorization` correto e
token **nunca** em log nem em erro · timeout por tipo de operação · redirect externo bloqueado
(`redirect: 'error'`) · host configurado validado (anti-SSRF) · `content-type` e tamanho de resposta
validados · TLS verificado (nunca `rejectUnauthorized: false`) · `criar` com 1 tentativa e sem retry
(D5) · DTO rejeita campos extras e as identidades proibidas da seção 5 · todos os HTTP/códigos WM da
seção 7 mapeados, e o `401` da WM **nunca** virando `401` local.

**Pronto quando:** os mocks baseados nas fixtures da seção 10 passam, sem tráfego real.

### Sessão 3 — Leitura (só produtos)

Depende de 2A e 2B. É aqui que `app.js` ganha o mount (seção 8). **Escopo reduzido por D11:** não
há rota de clientes — cliente e vendedor resolvem dentro de `preparar`, na Sessão 4.

**Novos:** `routes/wmOrcamentosRoutes.js` · `controllers/wmOrcamentosController.js` ·
`services/wm/wmAssistenteService.js` · cache LRU em memória (chave
`company_id + atualizado_em da config + endpoint + termo normalizado + página`, TTL 2–5 min, teto de
tamanho) · coalescência de requisições iguais em voo · `tests/wmAssistenteService.test.js` ·
`tests/wmOrcamentosIsolamento.test.js`

**Testes de isolamento:** `company_id` sempre do JWT · empresa A não lê nada da empresa B · usuário
sem acesso à conversa recebe 403 via `assertPermissaoConversa` · grupo/comunidade não inicia
orçamento · frontend não consegue substituir o telefone autorizado · toda query tem
`.eq('company_id', …)`.

**Atenção ao que o contrato diz dos candidatos de produto:** `/produtos/consultar` devolve
`multiplos_produtos` → `produtos[]` com **apenas** `codigo_produto_erp`, `descricao`, `marca` e
`unidade` — **sem preço e sem estoque**, e a descoberta de candidatos vem do **cache cloud**
(`04-contratos-api.md`). Então o picker não exibe preço nem estoque, e nada ali pode ser rotulado
como "atual". Preço e estoque só aparecem adiante: nos candidatos de `produto_ambiguo` da preparação
(que trazem `preco_unitario` e `estoque_previsto` realtime) e na prévia.

**Divisão 3A / 3B.** Nada do código acima depende de credencial: a rota, o controller, o service, o
cache e os testes de isolamento se fazem e se provam contra mock. Só a conferência final precisa de
base URL, token e da migration aplicada.

- **3A — pode começar já.** Todo o código e os testes, com mock. O mount em `app.js` entra aqui, e
  não abre superfície: `WM_ORCAMENTOS_ENABLED=false` mais o `requireOrcamentoWm` fail-closed
  respondem 403 a tudo. `acesso/validar` **não** é chamado por orçamento — só em provisionamento e
  diagnóstico.
  **Pronto quando:** suíte verde sem regressão, rota montada e fechada, nenhuma chamada de rede real
  nos testes.
- **3B — precisa de você.** `WM_API_BASE_URL` e `ZAPERP_API_TOKEN` por canal seguro, migration
  `20261020120000_wm_orcamentos.sql` aplicada no Supabase Editor, uma empresa piloto com o telefone
  autorizado provisionado e conferido com a WM, e a confirmação de que a API WM implantada já tem a
  paginação (rollout da WM é **Worker primeiro, API depois**).

  **A ferramenta de provisionamento existe** — é o [Anexo B](36-ANEXO-B-PROVISIONAMENTO.md), com os
  dois caminhos para a mesma linha de `wm_orcamento_integracoes`: `scripts/wm-provisionar-empresa.js`
  (confere a empresa, chama `acesso/validar` pelo `wmApiClient`, grava por `salvarConfig`, imprime só
  os últimos 4 dígitos; exige `--confirmar`, tem `--dry-run`, e nasce **desativado**) e o bloco SQL
  parametrizado para o Supabase Editor, que **não** valida contra a WM. Ativar é passo separado, e o
  anexo traz também o desprovisionamento por empresa sem perder histórico. Nenhuma rota HTTP: D7 e a
  pendência 13 continuam valendo, e a conferência do vínculo com a WM continua humana.

  **Pronto quando:** a empresa piloto pesquisa produtos por nome, com latência, paginação e logs
  observados.

### Sessão 4 — Preparação, snapshot e idempotência

**Novos:** `services/wm/wmOrcamentoService.js` (snapshot server-side, `comando_id`, transição
atômica) · `tests/wmOrcamentoPreparacao.test.js` · `tests/wmOrcamentoIdempotencia.test.js`

**Testes:** ambiguidade de cliente, de vendedor e de produto com `indice_item` diferente de zero ·
prévia pronta e prévia expirada · alteração de campo invalida a preparação · duplo clique simultâneo
chama a WM uma vez · F5 durante `ENVIANDO` não cria comando novo · mesmo comando com payload
diferente é barrado localmente · timeout vira `INCERTO` · nenhum POST tem retry automático.

**Divisão 4A / 4B — e aqui é onde a pendência 1 começa a doer.**

O que a WM **já** especifica por completo: as ambiguidades (`multiplos_clientes`,
`multiplos_vendedores`, `produto_ambiguo` + `indice_item` + `candidatos` + `paginacao`) e o payload
de `CriarOrcamento` (`telefone`, `comando_id`, `cliente_codigo_erp`, `vendedor_codigo_erp`,
`bloquear_apos_criar`, `itens[{codigo_produto_erp, quantidade, preco_confirmado}]`). O que ela
**não** especifica é a prévia — logo, não se sabe de qual campo sai cada `preco_confirmado`.

Como o **destino** é conhecido e só a **origem** falta, dá para construir tudo e deixar uma única
costura explícita:

- **4A — pode começar já.** Laço completo de resolução de ambiguidades; estrutura do snapshot (o
  payload de `criar` é conhecido); `payload_hash`; geração e persistência do `comando_id` **antes**
  do despacho; a transição atômica `PREPARADO → ENVIANDO` do SQL da seção 7; expiração da
  preparação; e todos os testes de idempotência e concorrência. A extração prévia → payload fica
  **isolada numa função só**, documentada como dependente da pendência 1, e os testes dela usam
  fixture própria marcada como provisória. A criação segue bloqueada.
  **Pronto quando:** suíte verde, duplo clique chama a WM uma vez, F5 durante `ENVIANDO` não cria
  comando novo, mesmo comando com payload diferente é barrado localmente, timeout vira `INCERTO`.
- **4B — precisa da WM.** Preencher aquela função com o schema real da prévia (pendência 1) e trocar
  a fixture provisória pelas fixtures sanitizadas. Depois, conferência humana da prévia contra o
  Icthus.

**Estado em 20/10: 4A e 4B implementadas.** O que a 4B trocou:

| Onde | O que |
|---|---|
| `services/wm/wmOrcamentoService.js` → `extrairPayloadCriacaoDaPrevia` | o bloco `CAMINHOS_PROVISORIOS` de nomes adivinhados saiu; agora lê o shape de §8 e aplica o mapeamento de §9.2. A flag `previa_schema_provisorio` da resposta foi removida |
| `services/wm/wmOrcamentoService.js` → `normalizarResultadoCriacao` (novo) | traduz o `200` de §10 no `wm_resultado_sanitizado`. Função pura, exportada, **não despacha nada** |
| `services/wm/wmOrcamentoService.js` → `previa_sanitizada` | agora leva cliente/vendedor canônicos, itens com `descricao`/`quantidade`/`preco_unitario`/`estoque_previsto`/`valor_total`, `valor_produtos`, `valor_total`, `bloquear_apos_criar` e `meta.fonte` (+ `meta.tempo_real` derivado) |
| `helpers/wmErrorMapper.js` | código novo `ORCAMENTO_DADOS_ALTERADOS`, mapeado por código (seção 5) |
| `services/wm/wmApiClient.js` → `resolveBaseUrl` | a base publicada já inclui `/api/v1/assistente`; o sufixo é cortado para o caminho do OpenAPI não entrar duas vezes |
| `tests/fixtures/wmPreviaProvisoria.js` → `tests/fixtures/wmPreviaReal.js` | fixture do shape real, com os exemplos de §8 e §10 copiados byte a byte |
| `tests/wmOrcamentoResultadoCriacao.test.js` (novo) | 19 testes do normalizador, incluindo a proibição de inferir "criado agora" |

Falta, e **não** é código: conferência humana da prévia e do orçamento criado contra o Icthus.

Decisões da 4A que a 4B e a 6 herdam:

1. **`payload_criacao` não guarda `telefone` nem `comando_id`.** Os dois são injetados no despacho
   por `montarPayloadDespacho`, que recalcula e confere o `payload_hash` antes de devolver o payload.
   Assim o telefone autorizado não ganha uma segunda tabela e o hash é estável entre preparação e
   confirmação. Consequência para D10: o replay é byte a byte idêntico **desde que o vínculo da
   empresa não tenha mudado** — e mudança de vínculo deve invalidar preparações, não ser contornada.
2. **Uma preparação viva por usuário + conversa.** Repreparar marca as `PREPARADO` anteriores como
   `EXPIRADO`, o que garante "alterar qualquer campo invalida a preparação" sem depender de comparar
   campo a campo (comparação deixaria escapar o campo que alguém esquecesse de comparar).
3. **Ambiguidade não cria linha no banco.** Não há o que confirmar, e persistir candidatos guardaria
   CPF/CNPJ/IE de quem o atendente nem escolheu. Os documentos vão à tela e param ali.
4. **Preço que não venha como string decimal faz a preparação FALHAR** (`WM_RESPOSTA_INVALIDA`,
   com alerta operacional). Nunca `Number`, nunca arredondamento, nunca preço do rascunho ou de
   candidato de ambiguidade como preço de criação.
5. **Prazo local em `WM_ORCAMENTOS_PREPARACAO_TTL_MS`** (default 10 min, faixa 1–60) e política em
   `WM_ORCAMENTOS_BLOQUEAR_APOS_CRIAR` (default `true`) — hoje por ambiente; quando virar coluna por
   empresa, só `politicaBloquearAposCriar` muda.
6. **`expira_em > now()` usa o relógio da API**, não o do banco: o PostgREST não aceita `now()` em
   filtro. TTL de minutos contra desvio de segundos — mas está registrado.

### Depois da 4B, o caminho está aberto

O parágrafo que havia aqui dizia que 4A era o último passo seguro sem resposta da WM, porque a
prévia e o resultado da criação não estavam no contrato. A 2ª remessa respondeu os dois, então:

- **5B** monta `OrcamentoPreview` e `OrcamentoResultado` (hoje placeholders honestos) consumindo a
  `previa_sanitizada` e o `wm_resultado_sanitizado` **já normalizados** — por governança (seção 13),
  o normalizador vem antes da tela, e é o que a 4B entregou;
- **6** liga o despacho: `wmApiClient.criarOrcamento` **sem `retryOpts`** (uma tentativa) em
  `confirmar` e em `verificar`, gravando o resultado por `normalizarResultadoCriacao`.

Uma regra nova que a 5B e a 6 não podem contrariar (§11.1): **"criado agora" × "resultado
idempotente já concluído" não existe na resposta da WM** e é proibido inferir por `meta.criado_em`.
Se a tela precisar da distinção, ela sai do NOSSO estado local — a operação já estava `CRIADO` antes
da chamada? — e de nada mais.

### Sessão 5 — Frontend

**Novos:** `frontend/src/api/wmOrcamentosService.js` (com `skipGlobal*Toast` em todas as chamadas) ·
`frontend/src/conversa/orcamento/{OrcamentoDrawer,OrcamentoForm,ProdutoPicker,ClientePicker,AmbiguidadePicker,OrcamentoPreview,OrcamentoResultado}.jsx` ·
`useOrcamentoDraft.js` (rascunho em `sessionStorage` por empresa + usuário + conversa, expiração
curta, limpo no logout; **nunca** token, telefone ou preço definitivo) · `orcamento.css` ·
formatador de moeda próprio, que devolve `"—"` para valor inválido

**Tocados:** os 5 pontos de registro do frontend na seção 8 — incluindo o teste da ordem de Escape.

**UX:** debounce de 700–900 ms e mínimo de 3 caracteres (busca só com intenção) · cancelar resposta
antiga quando o termo muda · quantidade padrão 1 com `−`/`+` · carrinho e total sempre visíveis ·
paginação como "Mostrar mais resultados" / "Voltar" · botão **"Confirmar e criar no ERP"**
desativado durante o envio e sem mudar de posição · "Voltar e editar" ao lado do botão principal ·
nenhuma mensagem técnica crua na tela (nunca `400`, `409`, `502`, `504`, `comando_id`,
`RESULTADO_INCERTO` ou stack trace).

**Layout do drawer:**

```
┌────────────────────────────────────────────┐
│ Novo orçamento                        [×]  │
├────────────────────────────────────────────┤
│ Cliente: João da Silva            [Trocar] │
│ Vendedor: Carlos Souza            [Trocar] │
├────────────────────────────────────────────┤
│ Pesquisar produto...                       │
│ ○ Notebook Lenovo IdeaPad — Lenovo / UN    │
│ ○ Notebook Dell Inspiron — Dell / UN       │
├────────────────────────────────────────────┤
│ Itens                                      │
│ Notebook Lenovo      [−] 1 [+]   [Remover] │
├────────────────────────────────────────────┤
│ Total oficial após calcular   [Calcular]   │
└────────────────────────────────────────────┘
```

O nome da conversa pode preencher a busca de cliente como sugestão editável, mas **nunca** virar
seleção canônica sem resposta da WM. Preço e estoque só aparecem quando vierem de resposta WM que os
garanta — principalmente a preparação — com indicação de origem; `cache_cloud` nunca é rotulado como
"atual".

**Testes visuais:** 390 / 768 / 1280 px, tema claro e escuro, teclado móvel e foco, scroll do drawer
sem mexer no `useAutoScroll` da conversa, ordem de Escape, lista virtualizada e composer intactos.

**Pronto quando:** um usuário conclui o caminho comum pesquisando só por nomes, sem conhecer código
ERP, e o rascunho sobrevive a erro e a fechamento acidental.

### Sessão 6 — Criação (só com a Sessão 0 resolvida)

Confirmação, criação idempotente, tela de resultado e resumo por template fixo com os dados oficiais
da WM. **"Enviar ao cliente"** é ação separada e explícita, usando o envio normal da conversa, com o
texto revisável antes de sair. Falha no envio do WhatsApp **não** cria outro orçamento. Replay
idempotente homologado com a WM. Runbook de suporte para `INCERTO`. Rollout: `orcamentos.criar`
liberado para poucos usuários de uma empresa piloto.

Template do resumo (formata, não calcula):

```
Olá, João! Segue seu orçamento:

1 × Notebook Lenovo IdeaPad — R$ 3.500,00
2 × Mouse sem fio — R$ 120,00

Total: R$ 3.740,00
Orçamento: 12345
```

### Sessão 7 — Separada e opcional

Aposentadoria da sync direta SQL Server → Postgres de produtos. **Nunca** junto com as sessões 2–6.

---

## 10. Pendências com a WM — status após ler o contrato (20/10)

Depois da 2ª remessa, **nenhum item bloqueia a Sessão 6**: os itens 1 e 2 foram respondidos. Os
itens 5, 6, 7 e 8 bloqueiam a produção, e o 13 bloqueia a produção multiempresa. O item 14 é novo.

| # | Pendência | Status |
|---|---|---|
| **1** | Schema de `pronto_para_confirmacao` | 🟢 **RESPONDIDA (2ª remessa, §8).** `dados` é plano: `status`, `cliente{codigo_cliente_erp,nome}`, `vendedor{codigo_vendedor_erp,nome}`, `itens[{codigo_produto_erp,descricao,quantidade,preco_unitario,estoque_previsto,valor_total}]`, `valor_produtos`, `valor_total`, `bloquear_apos_criar`, e `meta.fonte`. §8.1 fixa o preço em `itens[].preco_unitario` e §9.2 dá o mapeamento obrigatório para a criação. O `openapi.yaml` **continua** sem modelar a prévia dentro de `PrepararOrcamentoResposta` — então o guia é a fonte, e `extrairPayloadCriacaoDaPrevia` falha alto em qualquer outra forma. |
| **2** | Schema de sucesso de `/orcamentos/criar` | 🟢 **RESPONDIDA (2ª remessa, §10 e §11.1).** `dados{codigo_pedido_erp, documento_venda, cliente, vendedor, valor_total, bloqueado}` + `meta{fonte, criado_em}`. O número do orçamento é `dados.codigo_pedido_erp`. **E a resposta explícita da outra metade da pergunta: NÃO existe campo que distinga "criado nesta chamada" de "resultado idempotente já concluído"**, os dois são sucesso da mesma ação de negócio, e inferir por `meta.criado_em` é proibido; `meta.resultado_comando` é só sugestão de evolução (§15) e não deve ser consumido. Se a UI precisar da distinção, ela vem do nosso estado local. |
| **3** | Schemas de erro | 🟡 **PARCIAL.** A chave é `erro` e os códigos estão nomeados nos documentos (lista na seção 5); o `502` de `preparar` tem schema com `indice_item`. Falta: corpo estruturado do `409` da criação e o `shared/http/errors.ts` completo. Resolvido na prática com o ramo padrão por faixa de HTTP (seção 5). |
| **4** | Reconciliação de `RESULTADO_INCERTO` | 🟢 **RESPONDIDA.** Não há endpoint de status, mas §11 autoriza repetir com o mesmo `comando_id` e §13 garante resposta idempotente sem recriar. Verificação = reenviar o payload idêntico. Ver **D10**. |
| **5** | Retenção de idempotência | 🔴 **ABERTA.** Nenhum documento diz por quanto tempo a WM guarda `comando_id` e resultado. Define a retenção de `payload_criacao` (seção 6) e o prazo útil do "verificar". |
| **6** | Timeout/SLA | 🔴 **ABERTA.** `504 REALTIME_TIMEOUT` existe, mas sem número. O único limite publicado é 31 dias de período em vendas/rankings — não serve para orçamento. Sem isso, `WM_API_TIMEOUT_*` fica em estimativa. |
| **7** | Rate limits | 🔴 **ABERTA.** Há limite documentado só no login administrativo. Nada para `/assistente`. Ausência de documentação **não** é garantia de ausência de limite. |
| **8** | Decimais | 🟡 **PARCIAL.** A saída está definida: preço `0.00##` invariant, estoque `0.000` invariant com negativo. A entrada não: o padrão de `quantidade` aceita `0` e decimais ilimitados, e `preparar` aceita `number` ou `string`. Falta escala máxima, arredondamento e se `0` é recusado. Mitigado localmente (seção 5). |
| **9** | Campo do `preco_confirmado` | 🟢 **RESPONDIDA (2ª remessa, §8.1).** É `dados.itens[].preco_unitario`, que vem de `Estoque.[Preço Unitário]` no Icthus, e §9.2 manda reenviá-lo como `itens[].preco_confirmado`. O guia PROÍBE recalcular por `valor_total / quantidade`, buscar outra fonte ou alterar a escala. Regra mantida e agora testada: copiar a string byte a byte, e falhar se não vier como string decimal. |
| **10** | `bloquear_apos_criar` | 🟡 **PARCIAL.** Agora sabemos que é **obrigatório** em `preparar` e opcional em `criar` com `default: true` — ou seja, não dá para "não decidir". A semântica funcional continua indocumentada. Decisão local: default `true` por empresa, **o mesmo valor** em preparar e criar, guardado no snapshot; a prévia foi calculada sob aquela política. A 2ª remessa acrescentou que a prévia **ecoa** o campo (§8) e que o mapeamento prévia → criação o inclui (§9.2): por isso a 4B passou a usar o valor da prévia, com a política como fallback, sinalizando divergência no log. A semântica funcional segue indocumentada. |
| **11** | Ordem das ambiguidades | 🟢 **RESPONDIDA pela forma da resposta.** `dados.status` é um valor único e `candidatos` é uma lista única: a WM reporta **uma ambiguidade por vez**. A UI resolve uma, reprepara e eventualmente recebe a próxima — que é o fluxo já desenhado. |
| **12** | Um telefone por empresa, ou vários? | 🟢 **RESPONDIDA.** `assistente_contatos` tem `UNIQUE(telefone)` global e aceita vários contatos por sincronizador, mas a autorização exige **exatamente um** contato ativo correspondente: dois equivalentes dão `403`. O ZapERP usa **um** por empresa, inequívoco. |
| **13** | Prova de vínculo de tenant | 🔴 **ABERTA — e a WM declara que não a fornece.** `09-seguranca.md` é explícito: *"o Bearer não prova a origem WhatsApp de uma mensagem nem restringe uma credencial a uma única empresa"* e *"esses consumidores são confiáveis para informar o telefone"*. Não há identidade verificável para o consumidor: `/sincronizadores/identidade` exige o token do **Worker**, não o nosso, e `acesso/validar` devolve só `{autorizado:true}`. |
| **14** | `preco_negociado` — OpenAPI × guia | 🔴 **ABERTA (nova, 2ª remessa).** O `openapi.yaml` acrescentou `preco_negociado` (`PrecoNegociadoOrcamento`: decimal textual, > 0, ≤ 1000000, até 4 casas) aos itens de `preparar` **e** de `criar`; o guia afirma em §7.1 e §9.1 que **nenhuma das duas** o aceita. A precedência declarada pela WM é o OpenAPI, então isto é divergência real. **Decisão local: NÃO implementar.** O campo é opcional, logo não enviá-lo é seguro e concorda com o guia; e o próprio schema avisa que só um "Worker compatível" aplica a negociação — num Worker antigo o desconto seria **ignorado em silêncio** e o ERP gravaria o preço cheio, inaceitável sem forma de detectar o suporte. Como é chave desconhecida, o `additionalProperties: false` da nossa camada já a rejeita se vier do navegador (comentário registrado em `validators/wmOrcamentosValidators.js`). **Pedir à WM:** qual dos dois documentos vale, e como detectar Worker compatível. |

### O que o item 13 significa na prática

O `ZAPERP_API_TOKEN` pode operar sobre **qualquer** empresa cadastrada na WM, e o telefone enviado é
o único seletor de tenant. A WM confia no ZapERP para enviar o telefone certo e **não tem nenhuma
defesa** se o telefone errado for enviado.

Consequência direta: **o isolamento entre empresas desta integração é inteiramente responsabilidade
do ZapERP.** Isso transforma três regras de "preferíveis" em obrigatórias:

1. o telefone autorizado é resolvido **só** no servidor, a partir de `req.user.company_id` (seção 4);
2. nenhum body, query ou header do navegador influencia esse telefone, em nenhuma rota;
3. `orcamentos.configurar` **não existe** no catálogo — o vínculo é provisionado por operação
   confiável, conferido com a WM (D7, seção 4). Um admin de tenant que pudesse digitar o telefone
   leria o ERP de outra empresa.

Pedir à WM: identidade opaca/assinada devolvida em `acesso/validar`, ou um processo oficial de
provisionamento que prove o vínculo. Até então, **produção multiempresa permanece bloqueada** e o
piloto roda com uma empresa só, com o vínculo conferido manualmente.

### Fragilidades do OpenAPI — **todas confirmadas na leitura de 20/10**

Oito pontos, verificados linha a linha no arquivo versionado. Nenhum impede começar; todos pedem
validação defensiva local.

| Fragilidade | Como lidamos |
|---|---|
| `PrepararOrcamento.itens[]` exige só `quantidade`; **não** declara `oneOf` entre `codigo_produto_erp` e `busca` — um item sem nenhum dos dois passa pelo schema | o validador local exige exatamente um dos dois |
| `quantidade` é `oneOf [number, string]` sem padrão nem limites na preparação, e na criação casa `^\d+(?:\.\d+)?$`, que **aceita `0`** | sempre string; quantidade `> 0` barrada localmente (seção 5) |
| A resposta de preparação **não modela a prévia** | continua assim no `openapi.yaml` da 2ª remessa; a forma vem do guia (§8) e `extrairPayloadCriacaoDaPrevia` recusa qualquer outra — pendência 1 respondida pelo guia, não pelo schema |
| A criação **não modela resposta** nem o corpo dos conflitos `409` | o `200` veio no guia (§10) e está traduzido em `normalizarResultadoCriacao`; o corpo dos `409` segue sem schema — pendência 3 |
| `openapi.yaml` aceita `preco_negociado` nos itens; o guia diz que não existe | não enviamos, e a chave desconhecida é rejeitada na entrada — pendência 14 |
| `401/403/503/504` não aparecem de forma uniforme entre os endpoints do Assistente | o mapeador trata por faixa de HTTP, não por endpoint |
| **Não há seção `servers`** | base URL vem só de `WM_API_BASE_URL`; nunca de descoberta. A 2ª remessa publicou a base de produção (§2): `https://apiwmassistente.wmsistemas.inf.br/api/v1/assistente` — **HTTPS confirmado**, e ela **já inclui** o `/api/v1/assistente` que todos os caminhos do OpenAPI também trazem, então `resolveBaseUrl` corta esse sufixo para não montar o prefixo duas vezes. Está no `.env.example`, comentada; o token continua vindo por canal seguro |
| `meta` é só `type: object`, sem contrato para `fonte` e `sincronizado_em` | ler defensivamente, como opcional; não quebrar a tela se vier vazio |
| Declara OpenAPI 3.0.3 mas `Venda.documento_venda` usa `type: [string, 'null']`, sintaxe de 3.1 | é num schema do Worker, fora do nosso caminho; só avisar se gerarmos cliente a partir do arquivo |

### Fixtures sanitizadas a solicitar

Acesso autorizado e negado · produto único e múltiplos com paginação · cliente único e múltiplos ·
vendedor ambíguo · produto ambíguo em item diferente de zero · prévia completa · criação nova ·
replay idempotente do mesmo comando · mesmo comando com payload diferente · ERP offline · recusa
pré-escrita · timeout/resultado incerto.

---

## 11. Custo

Meta: **2 a 5 chamadas WM por orçamento** sem ambiguidade — `preparar` + `criar` = 2 no melhor caso;
3 buscas + preparar + criar = 5 no caso comum. Ambiguidade só acrescenta chamada quando o usuário
pede outra página ou reexecuta a preparação.

Controles: `acesso/validar` **nunca** por orçamento (só provisionamento e diagnóstico) · busca só
após 3 caracteres e 700–900 ms de pausa · uma requisição por termo estável · cache LRU em memória
(sem Redis) para candidatos · coalescência de requisições iguais em voo · **nunca** cachear
`preparar` nem `criar` · preparar o carrinho inteiro de uma vez · sem prefetch · sem polling · sem
Socket.IO, fila ou worker novo · sem IA, PDF ou envio automático · auditoria por mudança de estado,
não por autocomplete · persistência mínima (nada de tecla, lista de candidatos ou rascunho
incompleto no banco).

Teto opcional, se a WM cobrar por chamada: `WM_API_DAILY_REQUEST_BUDGET`,
`WM_API_SEARCH_REQUESTS_PER_MINUTE`, `WM_API_CREATE_REQUESTS_PER_MINUTE`. Ao atingir o teto,
bloquear buscas com mensagem clara — **nunca** bloquear a leitura de uma operação já `INCERTA`.

Métricas mínimas, sem serviço externo novo: chamadas por empresa/dia · chamadas por orçamento
concluído · taxa de cache · preparações por criação · ambiguidades por tipo · erros, timeouts e
incertos · latência média e p95.

Antes do go-live, pedir proposta comercial escrita e calcular três cenários: volume atual, 3× e 10×.
Não é possível prometer um valor em reais sem saber se a WM cobra por requisição, empresa,
sincronizador ou volume.

---

## 12. Critérios de aceite

1. Nenhum segredo WM no frontend, na rede do browser, em log ou em resposta.
2. Nenhum body ou query do navegador escolhe tenant WM.
3. Toda query nova filtra `company_id` do JWT.
4. Acesso à conversa revalidado por `assertPermissaoConversa`.
5. Busca paginada e nenhuma ambiguidade resolvida automaticamente.
6. Cliente e vendedor canônicos antes da prévia.
7. O preço da criação vem do snapshot server-side.
8. Alterar qualquer campo exige nova preparação.
9. A criação exige confirmação explícita.
10. `comando_id` persistido antes do despacho.
11. Duplo clique e concorrência não duplicam orçamento.
12. Timeout ou falha de rede pós-despacho vira `INCERTO`, e nenhum fluxo gera UUID novo para corrigi-lo.
13. Replay idempotente homologado com a WM.
14. Origem (`tempo_real` / `cache_cloud`) e horário exibidos corretamente.
15. UI correta em 3 breakpoints e 2 temas; `ProdutoConsultaPanel` e os caminhos de envio intactos.
16. A integração pode ser desligada por empresa sem perder histórico operacional.
17. O usuário comum conclui um orçamento sem conhecer código ERP; nenhum erro técnico cru aparece.
18. Falha ao enviar no WhatsApp não cria outro orçamento.

---

## 13. Governança

Qualquer alteração futura: versionar o novo `openapi.yaml`, comparar com o anterior, atualizar
**este documento e os testes de contrato antes do código**, classificar a mudança (compatível,
aditiva ou breaking), adaptar o backend antes do frontend, manter a flag desligada até os mocks
passarem, homologar a preparação antes de liberar a criação, nunca mexer em idempotência,
telefone/tenant ou preço sem revisão de segurança, e preservar compatibilidade com operações
`INCERTAS` criadas por versões anteriores.

**Baseline que não muda em silêncio:** orçamento manual, sem IA · pesquisa por nome como caminho
principal · seleção humana de cliente, vendedor e produto · quantidade definida pelo usuário ·
preço oficial pela WM · prévia e confirmação explícitas · `comando_id` persistido antes do
despacho · envio ao cliente só depois da criação confirmada · nenhuma credencial WM no navegador ·
custo controlado, sem chamada automática desnecessária.

| Data | Revisão | Resultado |
|---|---|---|
| 20/10/2026 | auditoria inicial (avulsa, fora do repo) | plano criado |
| 20/10/2026 | verificação contra o código ZapERP | 6 imprecisões corrigidas, 8 lacunas registradas, 10 decisões fechadas, plano de 8 sessões |
| 20/10/2026 | Sessão 2A implementada | fundação desligada: migration escrita e não aplicada, `requirePermissao`, gate por empresa, máquina de estados; `app.js` e frontend intactos |
| 20/10/2026 | Sessão 2B implementada | `wmApiClient` (3 políticas de retry; `criar` com 1 tentativa), `wmErrorMapper` (chave `erro`, ramo padrão por faixa, 401 da WM → 503 local), `wmOrcamentosValidators`; nenhum arquivo existente tocado |
| 20/10/2026 | Sessão 3A implementada | `POST /produtos/consultar` montado e fechado pela flag, `wmAssistenteService` + cache LRU com coalescência, testes de isolamento; única adivinhação do módulo é a forma do "produto resolvido" (conferência da 3B) |
| 20/10/2026 | Sessão 4A implementada | `wmOrcamentoService` (laço de ambiguidade, snapshot server-side, `comando_id`, transição atômica, expiração), 4 rotas novas, 111 testes. `confirmar` **não despacha**: faz a transição e para. A extração prévia → payload está isolada em `extrairPayloadCriacaoDaPrevia` com fixture provisória — é a única coisa que a 4B troca. `payload_criacao` guarda o payload de `criar` **sem** `telefone` e **sem** `comando_id` (injetados no despacho por `montarPayloadDespacho`), então `payload_hash` é estável entre preparação e confirmação |
| 20/10/2026 | contrato WM recebido e versionado em `../wm/` | 5 pendências respondidas, 4 parciais, 4 abertas (1, 2, 5, 6, 7, 8, 13 — contando as parciais que ainda travam produção). Novidades: **D11** (cliente/vendedor via `preparar`, `/clientes/consultar` fora do escopo), **D10 revisado** (verificar = reenviar o mesmo payload), envelope de erro usa a chave `erro`, limites concretos de DTO na seção 5, e o item 13 confirmado como responsabilidade exclusiva do ZapERP |
| 20/10/2026 | Sessão 4B implementada | 2ª remessa do contrato traduzida: `extrairPayloadCriacaoDaPrevia` lê o shape real de §8 e aplica o mapeamento de §9.2 (preço de `preco_unitario`, byte a byte; quantidade da prévia, com o rascunho como fallback), `previa_sanitizada` leva os campos reais + `meta.fonte`/`tempo_real` (`cache_cloud` nunca é "atual"), `normalizarResultadoCriacao` (novo, puro, não despacha) traduz o `200` de §10 e **não** infere "criado agora" (§11.1), `ORCAMENTO_DADOS_ALTERADOS` no mapeador por CÓDIGO com `FALHA_SEGURA`, base URL de produção no `.env.example` e sufixo `/api/v1/assistente` cortado no cliente. `preco_negociado` NÃO implementado — pendência 14. Fixture provisória substituída por `wmPreviaReal.js` |
| 20/10/2026 | Sessão 5A implementada (frontend, menos prévia e resultado) | `api/wmOrcamentosService.js` (os 3 `skipGlobal*Toast` **mais `silent: true`**, porque o toast de **429 não tem flag própria** no interceptor), `conversa/orcamento/{OrcamentoDrawer,OrcamentoForm,ProdutoPicker,AmbiguidadePicker,OrcamentoPreview,OrcamentoResultado}.jsx`, `useOrcamentoDraft.js`, `orcamentoFormat.js` (moeda devolve `"—"`; `trim()` da quantidade) e `orcamento.css`. Tocados: `httpTimeouts.js` (confirmar = 150 s, acima do teto de escrita do backend), `auth/permissions.js` (`canAcessarOrcamento`/`canCriarOrcamento`, códigos **pontilhados**), `ConversaHeader.jsx`, `ConversaViewOverlays.jsx`, `conversationEscapeOrder.js` + o teste dedicado. **`ConversaView.jsx` também foi tocado** (não previsto na seção 8): sem estado lá, o Escape fecharia a conversa com o drawer aberto — a cadeia é dirigida por `state`/`actions` do coordenador. `OrcamentoPreview`/`OrcamentoResultado` são placeholders honestos (pendências 1 e 2). Frontend 49/49 scripts Node; backend intacto |
