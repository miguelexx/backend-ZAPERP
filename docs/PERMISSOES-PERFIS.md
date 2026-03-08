# Permissões por Perfil de Usuário

**Níveis:** atendente | supervisor | admin

---

## Resumo de Acesso

| Tela / Recurso | Atendente | Supervisor | Admin |
|----------------|-----------|------------|-------|
| **Clientes** (aba ou tela) | ✅ | ✅ | ✅ |
| **Atendimentos** (chats) | ✅ | ✅ | ✅ |
| Configurações | ❌ | ✅ | ✅ |
| Chatbot (IA) | ❌ | ✅ | ✅ |
| Dashboard / Métricas | ❌ | ✅ | ✅ |
| Integrações Z-API | ❌ | ✅ | ✅ |
| Usuários (CRUD) | ❌ | ❌ | ✅ |
| Departamentos (CRUD) | ❌ | Ver | Criar/Editar/Excluir |
| Merge duplicatas | ❌ | ❌ | ✅ |
| Transferir setor | ❌ | ❌ | ✅ |
| Config SLA (editar) | ❌ | ❌ | ✅ |

---

## Funcionalidades no Atendimento

### Regra: Assumir antes de enviar

O usuário **só pode enviar mensagens** (texto, arquivo, reação, contato, ligação, observação) se tiver **assumido** a conversa antes. Isso mantém o WhatsApp organizado — um atendente por conversa ativa.

- **Admin:** pode enviar em qualquer conversa (não precisa assumir)
- **Supervisor / Atendente:** precisa clicar em **Assumir** antes de enviar. Se tentar enviar sem assumir → 403 "Assuma a conversa antes de enviar mensagens"

### O que exige "assumir" antes

- Enviar mensagem de texto
- Enviar arquivo (imagem, áudio, vídeo, documento)
- Enviar reação
- Remover reação
- Enviar contato
- Enviar ligação
- Atualizar observação

### O que não exige assumir

- Ver/ler conversa
- Assumir (clique em Assumir)
- Transferir
- Encerrar / Reabrir
- Adicionar/remover tags
- Listar mensagens

**Supervisor** vê conversas do **seu setor** + grupos. Pode fazer o mesmo que atendente nas que tem acesso.

**Admin** vê e gerencia tudo, e pode enviar em qualquer conversa sem assumir.

---

## Rotas Protegidas

### Auth apenas (todos)
- `/clientes/*` — CRUD clientes
- `/chats/*` — listar, detalhar, assumir, encerrar, transferir, mensagens (exceto merge e transferir setor)
- `/tags/*` — tags

### supervisorOrAdmin
- `/config/*` — configurações da empresa
- `/ia/*` — config chatbot, regras, logs
- `/dashboard/*` — overview, metrics, departamentos (listar), respostas-salvas, relatórios, SLA
- `/integrations/zapi/*` — status, QR, sync

### adminOnly
- `/usuarios` POST, PUT, DELETE — criar/editar/excluir usuários
- `/chats/merge-duplicatas` — mesclar conversas
- `/chats/:id/departamento` — transferir para outro setor
- `/dashboard/departamentos` POST, PUT, DELETE — CRUD setores
- `/dashboard/sla/config` PUT — editar config SLA

---

## Banco de Dados

`usuarios.perfil` aceita: `admin`, `supervisor`, `atendente` (case-insensitive).

Migração opcional para garantir:

```sql
-- Se precisar padronizar valores existentes
UPDATE usuarios SET perfil = LOWER(perfil)
WHERE perfil IS NOT NULL AND perfil != LOWER(perfil);
```
