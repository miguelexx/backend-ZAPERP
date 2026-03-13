# Sugestões de Melhorias no Código — Boas Práticas

**Data:** 2025-03-13  
**Escopo:** Backend whatsapp-plataforma

---

## 1. Arquitetura e Estrutura

### 1.1 Controllers muito grandes (God Objects)

**Problema:** `chatController.js` (~3150 linhas) e `webhookZapiController.js` (~2720 linhas) violam o princípio de responsabilidade única.

**Sugestão:**
- Extrair helpers de Socket.IO (`emitirConversaAtualizada`, `emitirEventoEmpresaConversa`, etc.) para `helpers/socketEmitter.js`
- Extrair lógica de permissões (`assertPermissaoConversa`, `assertPodeEnviarMensagem`) para `services/chatPermissionService.js`
- Dividir `webhookZapiController` em módulos por tipo de evento: `messageReceived`, `messageStatus`, `mediaHandler`, etc.
- Considerar padrão **Service Layer**: controllers finos (validar → chamar service → responder); lógica de negócio nos services.

### 1.2 Inconsistência na organização de rotas

**Problema:** `tagsRoutes` é importado no topo de `app.js` (linha 6) antes de outros, sem motivo aparente.

**Sugestão:** Agrupar todos os `require` de rotas em um único bloco, na ordem lógica (webhooks → auth → API).

### 1.3 Configuração centralizada

**Problema:** `process.env.*` espalhado em dezenas de arquivos; sem validação centralizada no boot.

**Sugestão:** Criar `config/env.js`:
```javascript
// Valida no startup; falha rápido se faltar algo crítico
const required = ['JWT_SECRET', 'APP_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']
const optional = ['ULTRAMSG_BASE_URL', 'OPENAI_API_KEY', ...]
module.exports = { get: (k) => process.env[k], validate }
```

---

## 2. Tratamento de Erros

### 2.1 Padrão inconsistente

**Problema:** Alguns controllers retornam `res.status(500).json({ error })`, outros fazem `throw` (que pode não ser capturado), outros usam `console.error` sem resposta padronizada.

**Sugestão:**
- Criar `middleware/errorHandler.js` central que capture erros e formate resposta JSON
- Usar classes de erro customizadas: `AppError`, `ValidationError`, `NotFoundError`
- Padronizar: `{ error: string, code?: string }` para o cliente

### 2.2 Falta de async/await em cadeias de Promise

**Problema:** Em `emitirConversaAtualizada`, usa-se `.then()/.catch()` em vez de `async/await`, dificultando fluxo e tratamento de erros.

**Sugestão:** Preferir `async/await` em funções assíncronas para legibilidade e stack traces melhores.

### 2.3 Erros de Supabase não padronizados

**Problema:** `if (error) throw error` em services propaga objeto Supabase; o controller pode não saber como mapear para HTTP.

**Sugestão:** Em services, mapear erros Supabase para erros de domínio e deixar o middleware de erro traduzir para HTTP.

---

## 3. Logging

### 3.1 Uso excessivo de console.log/error/warn

**Problema:** ~200+ chamadas a `console.*` no backend; sem níveis, sem estrutura, difícil filtrar em produção.

**Sugestão:**
- Adotar biblioteca estruturada: `pino` ou `winston`
- Níveis: `debug`, `info`, `warn`, `error`
- Em produção: `LOG_LEVEL=info`; nunca logar tokens/senhas
- Formato JSON para ingestão em ferramentas (Datadog, CloudWatch)

### 3.2 Logs sensíveis

**Problema:** Alguns logs podem expor `token`, `instance_id` ou dados de clientes.

**Sugestão:** Função `sanitize(obj)` que remove/mascara campos sensíveis antes de logar.

---

## 4. Validação de Entrada

### 4.1 Validação manual e inconsistente

**Problema:** Validação feita com `if (!x) return res.status(400)...` espalhada; sem schema reutilizável.

**Sugestão:** Usar **Zod** (já no projeto) para validar `req.body` e `req.query`:
```javascript
const schema = z.object({ cliente_id: z.number().int().positive() })
const parsed = schema.safeParse(req.body)
if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })
```

### 4.2 SQL/NoSQL Injection

**Problema:** Uso de `.or(\`nome.ilike.${term}\`)` — se `term` vier malicioso, pode quebrar.

**Sugestão:** Sempre sanitizar/escapar; Supabase geralmente protege, mas validar que `term` não contenha caracteres especiais perigosos.

---

## 5. Testes

### 5.1 Cobertura baixa

**Problema:** Apenas 3 arquivos de teste (auth, health, configOperacional); controllers principais sem testes.

**Sugestão:**
- Testes unitários para helpers (`phoneHelper`, `conversationSync`)
- Testes de integração para rotas críticas: `POST /chats/:id/mensagens`, webhooks
- Mock do Supabase com `supabase-mock` ou `msw`
- Meta: >60% de cobertura em services e helpers

### 5.2 Testes E2E

**Sugestão:** Script de smoke test que sobe o servidor, chama `/health`, `/api/dashboard/overview` (com token) e verifica resposta.

---

## 6. Segurança

### 6.1 Rate limiting

**Problema:** `webhookLimiter` e `apiLimiter` existem; verificar se limites são adequados para produção.

**Sugestão:** Revisar `express-rate-limit`; considerar rate limit por `company_id` em rotas sensíveis (ex.: envio de mensagens).

### 6.2 CORS hardcoded

**Problema:** `allowedOrigins` em `app.js` tem domínios fixos (`zaperp.wmsistemas.inf.br`).

**Sugestão:** Mover para `CORS_ORIGINS` no `.env`; manter localhost apenas em desenvolvimento.

### 6.3 Headers de segurança

**Status:** Helmet e Permissions-Policy já configurados — OK.

---

## 7. Performance

### 7.1 Queries N+1

**Problema:** Em `listarConversas`, múltiplas queries Supabase em sequência (tagRows, clientesMatch, convByCliente, etc.) podem ser otimizadas.

**Sugestão:** Consolidar em menos queries; usar `select` com joins quando possível; considerar RPC no Supabase para lógica complexa.

### 7.2 Cache

**Problema:** Dados como `empresa_zapi`, configurações operacionais são consultados frequentemente sem cache.

**Sugestão:** Cache em memória (TTL 30–60s) para `getEmpresaWhatsappConfig` e `getConfig` (configOperacional), com invalidação em updates.

### 7.3 Paginação

**Problema:** `listarConversas` pode retornar muitas linhas; não há `limit`/`offset` explícitos em algumas rotas.

**Sugestão:** Padronizar paginação: `?page=1&limit=50`; máximo de 100 itens por página.

---

## 8. Código e Manutenibilidade

### 8.1 Magic numbers e strings

**Problema:** Números como `4096`, `1024`, `1000` espalhados; strings como `'empresa_'`, `'conversa_'` repetidas.

**Sugestão:** Constantes nomeadas:
```javascript
const LIMITS = { BODY_MAX_LEN: 4096, CAPTION_MAX_LEN: 1024 }
const ROOM_PREFIX = { EMPRESA: 'empresa_', CONVERSA: 'conversa_' }
```

### 8.2 Comentários em português e inglês misturados

**Problema:** Inconsistência; alguns blocos em inglês, outros em português.

**Sugestão:** Padronizar em português (ou inglês) para todo o código; JSDoc em português se a equipe for brasileira.

### 8.3 Duplicação de lógica

**Problema:** Lógica de normalização de telefone, construção de payload Socket.IO repetida em vários pontos.

**Sugestão:** Extrair para helpers reutilizáveis; DRY (Don't Repeat Yourself).

### 8.4 Tipagem

**Problema:** JavaScript puro; sem tipos estáticos.

**Sugestão:** Considerar migração gradual para TypeScript ou adicionar JSDoc com `@param` e `@returns` para melhor autocomplete e documentação.

---

## 9. Documentação

### 9.1 API sem documentação formal

**Problema:** Não há OpenAPI/Swagger; rotas documentadas apenas em markdown dispersos.

**Sugestão:** Gerar `openapi.yaml` ou usar `swagger-jsdoc` para documentar rotas, parâmetros e respostas; servir `/api-docs` em desenvolvimento.

### 9.2 README do backend

**Sugestão:** README com: como rodar, variáveis de ambiente obrigatórias, estrutura de pastas, como rodar testes.

---

## 10. DevOps e Qualidade

### 10.1 ESLint e Prettier

**Problema:** Não há configuração explícita de lint no `package.json`.

**Sugestão:**
```json
"scripts": {
  "lint": "eslint . --ext .js",
  "lint:fix": "eslint . --ext .js --fix",
  "format": "prettier --write \"**/*.js\""
}
```

### 10.2 Pre-commit hooks

**Sugestão:** Husky + lint-staged para rodar lint antes de cada commit.

### 10.3 CI/CD

**Sugestão:** Pipeline (GitHub Actions, GitLab CI) que rode `npm test` e `npm run lint` em todo push/PR.

---

## Resumo de Prioridades

| Prioridade | Melhoria | Impacto | Esforço |
|------------|----------|---------|---------|
| Alta | Error handler centralizado | Estabilidade, UX | Baixo |
| Alta | Config env centralizada | Segurança, deploy | Baixo |
| Alta | Logging estruturado (pino) | Operação, debug | Médio |
| Média | Quebrar chatController em módulos | Manutenção | Alto |
| Média | Validação com Zod | Segurança, consistência | Médio |
| Média | Mais testes (helpers, rotas) | Confiabilidade | Alto |
| Baixa | Cache para config/empresa | Performance | Baixo |
| Baixa | OpenAPI/Swagger | Documentação | Médio |
| Baixa | ESLint + Prettier | Qualidade | Baixo |

---

## Referências

- [Node.js Best Practices](https://github.com/goldbergyoni/nodebestpractices)
- [Express Error Handling](https://expressjs.com/en/guide/error-handling.html)
- [Clean Code JavaScript](https://github.com/ryanmcdermott/clean-code-javascript)
