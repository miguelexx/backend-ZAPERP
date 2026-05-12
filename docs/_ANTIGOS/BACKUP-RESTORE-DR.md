# Backup, Restore e Disaster Recovery — ZapERP

**Documento:** Procedimentos de backup, restauração e recuperação de desastres  
**Data:** Março 2025  
**Responsável:** Equipe de Operações

---

## 1. Escopo dos Dados

| Sistema | Dados | Localização |
|---------|-------|-------------|
| Supabase (PostgreSQL) | Empresas, usuários, conversas, mensagens, clientes, campanhas, opt-in/opt-out, auditoria | Supabase Cloud |
| Backend | Uploads (imagens, áudios, documentos) | `backend/uploads/` |
| Backend | Logs (se persistidos) | Configurável |
| Z-API | Sessão WhatsApp (QR) | Z-API Cloud |

---

## 2. Backup do Supabase

### 2.1 Backup Automático (Plano Pro)

O Supabase oferece backup automático diário em planos pagos:
- **Free:** Sem backup automático
- **Pro:** Point-in-time recovery (PITR) — backup contínuo
- **Team/Enterprise:** PITR + retenção configurável

**Verificar em:** Supabase Dashboard → Project Settings → Infrastructure

### 2.2 Backup Manual (pg_dump)

Para planos sem PITR ou backup adicional:

```bash
# Obter connection string em: Supabase → Settings → Database
pg_dump "postgresql://postgres:[PASSWORD]@[HOST]:5432/postgres" \
  --format=custom \
  --file=zaperp_backup_$(date +%Y%m%d_%H%M).dump
```

**Frequência recomendada:** Diário (cron) ou antes de migrations.

### 2.3 RPO (Recovery Point Objective)

| Plano | RPO Sugerido |
|-------|--------------|
| Free | 24h (backup manual diário) |
| Pro+ | 1h ou menos (PITR) |

---

## 3. Backup de Uploads

Os arquivos em `backend/uploads/` não estão no Supabase. Devem ser incluídos no backup do servidor.

```bash
# Compactar uploads
tar -czvf uploads_backup_$(date +%Y%m%d).tar.gz backend/uploads/

# Ou sincronizar para storage (S3, GCS)
aws s3 sync backend/uploads/ s3://bucket/zaperp/uploads/
```

**Frequência:** Diária, junto com backup do banco.

---

## 4. Restore do Banco

### 4.1 Restore a partir de pg_dump

```bash
# Parar aplicação antes do restore
pg_restore -d "postgresql://..." --clean --if-exists zaperp_backup_YYYYMMDD.dump
```

**Atenção:** `--clean` remove objetos antes de recriar. Testar em ambiente de staging primeiro.

### 4.2 PITR (Supabase Pro)

1. Supabase Dashboard → Database → Backups
2. Selecionar ponto no tempo desejado
3. Restore cria novo projeto; migrar connection string

---

## 5. Procedimento de DR (Disaster Recovery)

### 5.1 Falha do Backend (aplicação)

1. Verificar logs: `pm2 logs` ou logs do provedor
2. Restart: `pm2 restart zaperpapi`
3. Se persistir: rollback para versão anterior (`git checkout` + `pm2 restart`)
4. Escalar: múltiplas instâncias atrás de load balancer

### 5.2 Falha do Supabase

1. Verificar status: https://status.supabase.com
2. Se indisponibilidade prolongada: restore em novo projeto Supabase
3. Atualizar `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` no .env
4. Redeploy do backend

### 5.3 Falha da Z-API

1. Verificar status do provedor Z-API
2. Mensagens pendentes: serão perdidas se Z-API não persistir fila
3. Reconectar instâncias: painel Z-API ou endpoint de restart
4. QR Code: clientes precisarão escanear novamente se sessão for perdida

### 5.4 Vazamento ou Comprometimento

1. Rotacionar imediatamente: JWT_SECRET, ZAPI_WEBHOOK_TOKEN, SUPABASE_SERVICE_ROLE_KEY
2. Invalidar sessões: trocar JWT_SECRET invalida todos os tokens
3. Revisar logs de acesso e auditoria_log
4. Notificar clientes se dados foram expostos (LGPD)

---

## 6. Checklist de Backup

| Item | Frequência | Responsável |
|------|------------|-------------|
| Backup pg_dump (se sem PITR) | Diário 02:00 | Cron / Ops |
| Backup uploads | Diário | Cron / Ops |
| Teste de restore | Mensal | Ops |
| Documentar credentials em cofre | Contínuo | Ops |
| Revisar RPO/RTO com negócio | Trimestral | Produto |

---

## 7. Variáveis de Ambiente Críticas

Manter cópia segura (1Password, Vault, etc.):

- `JWT_SECRET`
- `ZAPI_WEBHOOK_TOKEN`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `CRON_SECRET` (para jobs)
- `OPENAI_API_KEY` (se usado)

---

*Documento criado conforme auditoria de prontidão para produção. Revisar e atualizar conforme evolução do sistema.*
