# Contexto do backend para IAs

> Revisado em 2026-08-23 · branch `master` · commit-base `66e0771d9f61f840524cd4b0645e742df374a77a` + working tree existente.

Documentação oficial de handoff: [`docs/AI_HANDOFF.md`](docs/AI_HANDOFF.md) (contexto rápido, uma página) · [`docs/README.md`](docs/README.md) (índice mestre) · [`docs/ai-handoff/`](docs/ai-handoff/) (série técnica completa, 17 docs — comece por [`00-LEIA-PRIMEIRO.md`](docs/ai-handoff/00-LEIA-PRIMEIRO.md)).

Frontend (série separada, carregar só a sessão da tarefa): [`../frontend/docs/ai-handoff/00-LEIA-PRIMEIRO.md`](../frontend/docs/ai-handoff/00-LEIA-PRIMEIRO.md). Índice-mestre: [`../docs/ai-handoff/00-LEIA-PRIMEIRO.md`](../docs/ai-handoff/00-LEIA-PRIMEIRO.md).

Regras críticas: trabalhe somente no backend; preserve o isolamento por `company_id`; trate envio WhatsApp, jobs, migrations, retenção e deploy como operações reais e potencialmente destrutivas; nunca revele segredos ou dados de clientes. Código e migrations prevalecem sobre documentação divergente. Não execute migrations, deploy, envio real, commit ou push sem autorização explícita.

Ao alterar arquitetura, API, banco, integrações, sockets ou regras de negócio, atualize os documentos de `docs/ai-handoff/` no mesmo trabalho. Marque o que não puder confirmar como `NÃO CONFIRMADO` ou `PENDENTE DE VALIDAÇÃO`.
