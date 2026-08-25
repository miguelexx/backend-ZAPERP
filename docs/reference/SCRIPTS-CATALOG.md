# Catálogo de scripts de manutenção

> Atualizado: **2026-08-24** · branch `master`.  
> Scripts em `backend/scripts/`. Todos leem `.env` — execute no servidor ou com `.env` local configurado. Nenhum faz deploy nem aplica migrations.

---

## Regra geral

- Execute no diretório `backend/`: `node scripts/<nome>.js`
- Scripts com flag `--apply` ou equivalente rodam em **dry-run por padrão**; só causam efeito com a flag explícita.
- Nunca passar segredos reais como argumento de linha de comando em ambientes compartilhados — use variáveis de ambiente.

---

## Scripts de administração de usuários e instâncias

| Script | Uso | Efeito |
|--------|-----|--------|
| `criar-admin.js` | `node scripts/criar-admin.js [email] [senha]`<br>ou env `ADMIN_EMAIL`, `ADMIN_SENHA` | Cria usuário admin no banco. Útil quando todos os usuários foram excluídos. Sem efeito de provider. |
| `configurar-ultramsg.js` | `node scripts/configurar-ultramsg.js [company_id]`<br>env: `ULTRAMSG_INSTANCE_ID`, `ULTRAMSG_TOKEN`, `COMPANY_ID` | Grava credenciais UltraMSG na tabela `empresa_zapi`. Equivalente a configurar via UI de admin. |
| `diagnose-whatsapp-instance-lookup.js` | `node scripts/diagnose-whatsapp-instance-lookup.js` | Diagnóstica se o backend consegue resolver `instanceId → company_id` para as instâncias configuradas; identifica instâncias sem empresa mapeada. |

---

## Scripts de chatbot

| Script | Uso | Efeito |
|--------|-----|--------|
| `setup-all-chatbots.js` | `node scripts/setup-all-chatbots.js [--force] [--dry-run]` | Configura chatbot de triagem para todas as empresas ativas. `--force` reconfigura mesmo se já existir. `--dry-run` simula. |
| `validate-chatbot-setup.js` | `node scripts/validate-chatbot-setup.js [company_id] [--fix] [--detailed]` | Valida integridade do setup do chatbot (configs, dependências). `--fix` tenta reparar automaticamente. |

---

## Scripts de diagnóstico e auditoria

| Script | Uso | Efeito |
|--------|-----|--------|
| `webhook-logs-query.js` | `node scripts/webhook-logs-query.js` | Lista registros recentes de `webhook_logs` via Supabase; sem alteração de banco. |
| `verificar-clientes-por-empresa.js` | `node scripts/verificar-clientes-por-empresa.js audit`<br>`node scripts/verificar-clientes-por-empresa.js sync <company_id> <JWT>` | **audit:** verifica isolamento de clientes por `company_id`.<br>**sync:** chama `POST /integrations/whatsapp/contacts/sync` para uma empresa. |
| `simular-msg-celular.js` | `node scripts/simular-msg-celular.js [--phone ...] [--texto ...] [--tipo delivery]` | Simula webhook `fromMe: true` (mensagem enviada pelo celular). Útil para testar o fluxo de eco sem WhatsApp real. Envia HTTP para o endpoint local. |
| `load-smoke.js` | `BASE_URL=http://localhost:3000 JWT_SECRET=... node scripts/load-smoke.js` | Smoke test de carga leve. Não envia mensagens reais; testa endpoints autenticados repetidamente e mede latência/erros. |

---

## Scripts de Cloudflare R2

Todos exigem variáveis R2 no `.env` (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_URL`). Falha em qualquer etapa é reportada sem apagar dados.

| Script | Uso | Efeito |
|--------|-----|--------|
| `r2-smoke.js` | `node scripts/r2-smoke.js` | Valida credenciais R2 end-to-end: PUT → HEAD → GET presigned → DELETE de objeto de teste. **Inofensivo.** Use antes de habilitar o mirror. |
| `r2-migrate-historico.js` | `node scripts/r2-migrate-historico.js [company_id]` | Migra em massa `/uploads` histórico para R2. Idempotente, resumível por cursor, **não apaga arquivo local**. Só atualiza `storage_key` no banco depois de confirmar objeto no R2. |
| `r2-disk-cleanup.js` | `node scripts/r2-disk-cleanup.js` | Remove arquivos locais de `/uploads` que **já estão no R2** (`storage_backend='r2'`). Mostra espaço antes/depois. Execute só após validar imagens no R2. |
| `r2-diagnose-outbound.js` | `node scripts/r2-diagnose-outbound.js [limit]` | Diagnóstica e tenta espelhar mídias enviadas (outbound) da empresa habilitada que não foram para o R2. Idempotente — só espelha o que deveria estar lá. |

---

## Scripts de reprocessamento

| Script | Uso | Efeito |
|--------|-----|--------|
| `reprocessar-webhooks-ultramsg-falhos.js` | `node scripts/reprocessar-webhooks-ultramsg-falhos.js --start=ISO --end=ISO [--company=ID] [--limit=N] [--apply]` | Relê `webhook_logs` no intervalo e reenvia payloads falhos para `/webhooks/ultramsg`. **Dry-run por padrão** (sem `--apply`, só lista). Idempotente por `whatsapp_id`. Útil após falha de coluna/migration. |

---

## Pasta `certificacao/`

Scripts e SQLs em `scripts/certificacao/` para verificação do sistema antes de produção:

| Arquivo | Propósito |
|---------|-----------|
| `verificar-sistema.js` | Checklist de saúde do sistema (env, banco, provider, agendadores). |
| `verificar-com-backend.js` | Verifica saúde via endpoints HTTP do próprio backend. |
| `deduplicate-conversations.js` | Remove conversas duplicadas (mesmo tenant/telefone/instância). |
| `executar-certificacao-sql.js` | Runner dos SQLs de certificação abaixo. |
| `test-sync-contatos.js` | Testa fluxo de sincronização de contatos. |
| `*.sql` | Queries de auditoria: antiduplicação, contatos sem foto, duplicados, prova. |
| `fix-mensagens-wrong-company-id.sql` | Correção de `company_id` errado em mensagens (use com cuidado). |

---

## Scripts de teste manual

Scripts de diagnóstico rápido que simulam chamadas reais ao sistema. Não fazem parte da suite Jest — são acionados manualmente durante desenvolvimento ou debug.

| Script | Uso | Efeito |
|--------|-----|--------|
| `test-chatbot.js` | `node scripts/test-chatbot.js` | Testa fluxo do chatbot de triagem para uma empresa. Pode gerar mensagens de teste no banco. |
| `test-encaminhamento.js` | `node scripts/test-encaminhamento.js` | Testa funcionalidade de encaminhamento de mensagens entre conversas. |
| `test-ultramsg-contacts.js` | `node scripts/test-ultramsg-contacts.js` | Consulta `GET /contacts` e `GET /contacts/contact` na API UltraMSG e imprime resposta. Não altera banco. |

---

## Aviso de segurança

Scripts que escrevem no banco de produção (`criar-admin`, `configurar-ultramsg`, `reprocessar-webhooks-ultramsg-falhos --apply`, `r2-disk-cleanup`, `r2-migrate-historico`, `certificacao/fix-*.sql`) devem ser executados **só com `.env` de produção apontando para o banco correto** e com backup recente. Confirmar `SUPABASE_URL` antes de rodar.
