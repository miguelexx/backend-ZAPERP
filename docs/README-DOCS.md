# Documentação ZapERP Backend

Índice da documentação técnica e operacional.

---

## Operacional e Produção

| Documento | Descrição |
|-----------|-----------|
| [AUDITORIA-BACKEND-PRONTIDAO-PRODUCAO.md](./AUDITORIA-BACKEND-PRONTIDAO-PRODUCAO.md) | Auditoria de prontidão para produção e venda SaaS |
| [MELHORIAS-IMPLEMENTADAS-AUDITORIA.md](./MELHORIAS-IMPLEMENTADAS-AUDITORIA.md) | Resumo das melhorias implementadas |
| [BACKUP-RESTORE-DR.md](./BACKUP-RESTORE-DR.md) | Procedimentos de backup, restore e disaster recovery |
| [CONFIGURACAO-WEBHOOK-ZAPI-TOKEN.md](./CONFIGURACAO-WEBHOOK-ZAPI-TOKEN.md) | Como configurar o token no webhook Z-API |
| [ULTRAMSG-CONFIGURACAO-ENVIO.md](./ULTRAMSG-CONFIGURACAO-ENVIO.md) | UltraMsg: webhooks, API de mensagens, formato de envio certificado |
| [CERTIFICACAO-ULTRAMSG-DOCUMENTACAO.md](./CERTIFICACAO-ULTRAMSG-DOCUMENTACAO.md) | Certificação doc vs sistema — auditado |
| [FEATURE-FLAGS.md](./FEATURE-FLAGS.md) | Feature flags via ENV |

---

## Planejamento e Evolução

| Documento | Descrição |
|-----------|-----------|
| [PLANO-EVOLUCAO-SAAS-PRONTO-PARA-VENDER.md](./PLANO-EVOLUCAO-SAAS-PRONTO-PARA-VENDER.md) | Plano de evolução do produto SaaS |
| [PROTEÇÃO-OPERACIONAL-WHATSAPP-ZAPI.md](./PROTEÇÃO-OPERACIONAL-WHATSAPP-ZAPI.md) | Módulos de proteção e boas práticas |

---

## Pré-requisitos para Produção

1. **Migration obrigatória:** `supabase/migrations/20260310000000_opt_in_opt_out_campanhas_auditoria.sql`
2. **Webhook Z-API:** Configurar URL com `?token=ZAPI_WEBHOOK_TOKEN`
3. **Variáveis de ambiente:** Ver [BACKUP-RESTORE-DR.md](./BACKUP-RESTORE-DR.md) § 7
