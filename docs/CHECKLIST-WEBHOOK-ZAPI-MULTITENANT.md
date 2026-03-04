# Checklist: Webhook Z-API Multi-Tenant

Garantia: **nenhum insert do webhook depende de DEFAULT company_id=1**.

## Verificações de Prova Final

### A) Enviar mensagem para instância da empresa 2

1. Conecte a instância Z-API da empresa 2 (instance_id em `empresa_zapi`).
2. Envie uma mensagem de teste (pelo celular ou API).

### B) Confirmar no banco

```sql
-- Troque <messageId> pelo whatsapp_id da mensagem enviada (ex: 3A1E59993ACD7C37A315)
SELECT id, company_id, whatsapp_id, conversa_id, texto, direcao, criado_em
FROM public.mensagens
WHERE whatsapp_id = '<messageId>';
```

**Esperado:** `company_id = 2` (ou o ID da empresa que possui a instância).

### C) Confirmar que empresa 1 continua funcionando

1. Envie/receba mensagem na instância da empresa 1.
2. Verifique no banco:

```sql
SELECT company_id, whatsapp_id, texto, criado_em
FROM public.mensagens
WHERE company_id = 1
ORDER BY criado_em DESC
LIMIT 5;
```

**Esperado:** Mensagens recentes com `company_id = 1`.

### D) Verificar mapeamento instanceId → company_id

```sql
SELECT ez.company_id, ez.instance_id, e.nome
FROM empresa_zapi ez
JOIN empresas e ON e.id = ez.company_id
WHERE ez.ativo = true;
```

Cada `instance_id` deve mapear para o `company_id` correto.

### E) Log do webhook

Ao receber webhook, deve aparecer no console:

```
[ZAPI_WEBHOOK] {"instanceId":"3EFA22A7A04031AAF064...","companyId":2,"type":"ReceivedCallback","messageId":"3A1E59993ACD7C37A315","phone":"…9999999999","fromMe":false}
```

- `instanceId`: truncado, sem tokens
- `companyId`: numérico (1, 2, …)
- Nunca deve aparecer token nem URL com `/token/`

## Resumo das correções (patch)

| Área | Correção |
|------|----------|
| `receberZapi` | Resolve `company_id` por `instanceId` no início; retorna `ignored: instance_not_mapped` se não mapeado |
| `insertMsg` (mensagens) | Sempre `company_id` explícito no objeto |
| `insert` (clientes) | Sempre `company_id` explícito |
| `findOrCreateConversation` | Já usa `company_id` em insert e select |
| `mergeConversasIntoCanonico` | Updates com `.eq('company_id', company_id)` |
| Busca idempotência | `.eq('company_id', company_id).eq('whatsapp_id', messageId)` |
| Log | `[ZAPI_WEBHOOK]` uma linha, sem tokens |
