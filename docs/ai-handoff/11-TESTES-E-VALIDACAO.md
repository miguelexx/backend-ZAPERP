# Testes e validação

> Análise/execução: 2026-08-23 · `master` · commit-base `66e0771d9f61f840524cd4b0645e742df374a77a` · fontes: `package.json`, `tests/`, configuração Jest implícita e execução local descrita abaixo.

## Ferramentas e organização

Jest 29, Supertest e mocks manuais. Há 100 arquivos `tests/*.test.js`; `tests/setup.js` substitui globalmente o cliente Supabase por chain mock. Suites também mockam `fetch`, provider UltraMSG, R2, OpenAI/push e filesystem conforme o caso. Predominam testes unitários e de controller com app em memória; não são integração com PostgreSQL/RLS/UltraMSG real.

Cobertura observada: autenticação/autorização, tenants, conversas, mensagens/status/ACK, multi-instância, webhooks, mídia/conversão/proxy/R2, chatbot/triagem, ausência/SLA/supervisão, clientes/importação, help desk, produtos e todas as etapas do Disparo. Lacunas: banco real e ordem de migrations, RLS com role não privilegiada, topologia multi-processo/Redis ausente, VPS/proxy, latência/retry reais do provider e carga sustentada.

## Resultado real desta auditoria

O working tree mudou durante a análise e os testes afetados de Disparo foram corrigidos pelo trabalho já existente. Resultado final, executado com as três flags de Disparo removidas do ambiente, `NODE_ENV=test` e `ZAPERP_DISABLE_BACKGROUND_JOBS=1`:

```text
npm test
Test Suites: 100 passed, 100 total
Tests:       1015 passed, 1015 total
Time:        57.746 s
```

O Jest imprimiu “did not exit one second after the test run has completed” e permaneceu com handle aberto; após registrar o resumo de sucesso, o processo precisou receber interrupção. Portanto as asserções passaram, mas o encerramento limpo da suíte não passou: investigar com `--detectOpenHandles`. Rerun isolado de `disparoSendService` + `disparoWorkerConfig`: **2 suites/19 testes passaram**, com o mesmo aviso de handle aberto.

Uma execução anterior, feita enquanto os arquivos ainda mudavam e com flags off/dry-run impostas externamente, teve 3 falhas induzidas por essa configuração; ela foi substituída pelo resultado final acima. Nenhuma chamada real ocorreu: Supabase/provider são mocks nos testes envolvidos. Logs `console.error/warn` previstos por casos negativos não equivalem a falha. Um teste de exportação de revisão provoca internamente `TypeError` e HTTP 500, mas a expectativa atual ainda passa por verificar sanitização; registrar como dívida em [13](13-PROBLEMAS-CONHECIDOS-E-DIVIDA-TECNICA.md).

## Execução segura

1. Usar banco/provider/storage mocks; nunca carregar credencial de produção.
2. Definir `NODE_ENV=test` e `ZAPERP_DISABLE_BACKGROUND_JOBS=1`.
3. Para suite completa, não forçar flags que o próprio teste precisa variar; confirmar antes que suites de provider usam mock.
4. Não executar `cert:verificar`, `cert:verificar:local`, `load:smoke`, scripts de admin/webhook ou worker sem ler o script e preparar ambiente isolado.
5. Não apontar `APP_URL`, Supabase, UltraMSG, R2, FCM, OpenAI ou bancos de produtos para produção.

## Checklist pré-deploy

- `npm ci` em ambiente limpo e `npm test` sem falhas não justificadas.
- Testes negativos com duas empresas para toda query/room nova.
- Migration testada em clone descartável, incluindo precheck, rollback lógico e constraints.
- Cobrir idempotência, ACK fora de ordem, callback duplicado, timeout antes/depois da chamada e reload/reconexão.
- Uploads: tipo, assinatura, tamanho, path traversal, ZIP bomb, redirect e host privado.
- Disparo: defaults safe, allowlist de homologação, dry-run e recuperação de lease/incerto.
- Smoke local seguro: `/health`, `/health/detailed` com DB de teste, auth 401, webhook sem token 401. Não chamar QR/restart/sync/envio.

Testes contra serviços reais são **PENDENTE DE VALIDAÇÃO** e devem existir em ambiente de homologação isolado, com números/tenants próprios, opt-out e teto de gasto. Permanecem desativados por padrão.
