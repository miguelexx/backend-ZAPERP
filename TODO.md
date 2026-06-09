# Auditoria ZapERP Backend — TODO

## Etapa 1 — Análise concluída
- [x] Ler arquivos críticos de bootstrap/runtime:
  - [x] package.json
  - [x] index.js
  - [x] app.js
  - [x] config/env.js
  - [x] config/supabase.js
- [x] Ler middlewares críticos de segurança:
  - [x] middleware/auth.js
  - [x] middleware/authBearerOrQuery.js
  - [x] middleware/adminOnly.js
  - [x] middleware/supervisorOrAdmin.js
  - [x] middleware/rateLimit.js

## Etapa 2 — Correções seguras de baixo risco (em execução)
- [x] Ajustar robustez do parser URL-encoded para evitar payloads excessivos
- [x] Corrigir comentário inconsistente no shutdown (clareza operacional)
- [x] Melhorar segurança de JWT no middleware auth (verificação defensiva de token ausente após split)

## Etapa 3 — Validação
- [ ] Executar testes/lint/build/start disponíveis com segurança
- [ ] Registrar falhas pré-existentes vs introduzidas

## Etapa 4 — Relatório final profissional
- [ ] O que foi analisado
- [ ] Problemas encontrados
- [ ] Correções aplicadas
- [ ] Arquivos alterados
- [ ] Itens não alterados por risco
- [ ] Resultado da validação
- [ ] Veredito produção
