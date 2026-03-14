# API de Mensagens UltraMsg

Esta documentação descreve as rotas implementadas para acessar mensagens enviadas através da integração UltraMsg.

## Rotas Disponíveis

### 1. Listar Mensagens

**Endpoint:** `GET /integrations/whatsapp/messages`  
**Autenticação:** Requer token JWT válido  
**Permissões:** Supervisor ou Admin

#### Parâmetros de Query

| Parâmetro | Tipo | Padrão | Descrição |
|-----------|------|--------|-----------|
| `token` | string | - | **Obrigatório.** Token da instância UltraMsg |
| `page` | integer | 1 | Número da página (mínimo: 1) |
| `limit` | integer | 100 | Itens por página (mínimo: 1, máximo: 100) |
| `status` | string | 'all' | Status das mensagens |
| `sort` | string | 'desc' | Ordenação (asc ou desc) |

#### Status Válidos

- `all` - Todas as mensagens
- `queue` - Mensagens na fila
- `sent` - Mensagens enviadas
- `unsent` - Mensagens não enviadas
- `invalid` - Mensagens inválidas
- `expired` - Mensagens expiradas

#### Exemplos de Uso

```bash
# Listar todas as mensagens (página 1, 100 itens)
GET /integrations/whatsapp/messages?token=r6ztawoqwcfhzrdc&page=1&limit=100

# Listar apenas mensagens enviadas
GET /integrations/whatsapp/messages?token=r6ztawoqwcfhzrdc&status=sent

# Listar mensagens na fila
GET /integrations/whatsapp/messages?token=r6ztawoqwcfhzrdc&status=queue

# Listar mensagens não enviadas
GET /integrations/whatsapp/messages?token=r6ztawoqwcfhzrdc&status=unsent

# Listar mensagens inválidas
GET /integrations/whatsapp/messages?token=r6ztawoqwcfhzrdc&status=invalid

# Listar mensagens expiradas
GET /integrations/whatsapp/messages?token=r6ztawoqwcfhzrdc&status=expired
```

#### Resposta de Sucesso (200)

```json
{
  "messages": [
    {
      "id": "message_id",
      "to": "+5534999999999",
      "body": "Texto da mensagem",
      "status": "sent",
      "created_at": "2026-03-14T10:30:00Z",
      "sent_at": "2026-03-14T10:30:05Z",
      "delivered_at": "2026-03-14T10:30:10Z",
      "read_at": "2026-03-14T10:35:00Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 100,
    "status": "all",
    "sort": "desc"
  }
}
```

### 2. Estatísticas de Mensagens

**Endpoint:** `GET /integrations/whatsapp/messages/statistics`  
**Autenticação:** Requer token JWT válido  
**Permissões:** Supervisor ou Admin

#### Parâmetros de Query

| Parâmetro | Tipo | Descrição |
|-----------|------|-----------|
| `token` | string | **Obrigatório.** Token da instância UltraMsg |

#### Exemplo de Uso

```bash
GET /integrations/whatsapp/messages/statistics?token=r6ztawoqwcfhzrdc
```

#### Resposta de Sucesso (200)

```json
{
  "sent": 150,
  "queue": 5,
  "unsent": 2,
  "invalid": 1,
  "expired": 0
}
```

## Códigos de Erro

| Código | Descrição |
|--------|-----------|
| 400 | Parâmetros inválidos |
| 401 | Não autenticado |
| 404 | Empresa sem instância configurada |
| 429 | Muitas requisições (rate limit) |
| 500 | Erro interno do servidor |
| 502 | Erro na comunicação com UltraMsg |

## Rate Limiting

- **Mensagens:** Máximo 30 requisições por minuto por empresa
- **Estatísticas:** Máximo 20 requisições por minuto por empresa

## Status de Visualização

As mensagens retornadas incluem informações sobre o status de entrega e visualização:

- `created_at` - Quando a mensagem foi criada
- `sent_at` - Quando a mensagem foi enviada
- `delivered_at` - Quando a mensagem foi entregue
- `read_at` - Quando a mensagem foi lida (visualizada)

**Nota:** O status de visualização (`read_at`) depende da configuração de webhooks da UltraMsg e só estará disponível se os webhooks estiverem configurados corretamente para receber eventos de confirmação de leitura.

## Configuração de Webhooks

Para receber status de visualização, certifique-se de que os webhooks estão configurados com:

- `webhook_message_ack: true` - Para receber confirmações de entrega e leitura
- `webhook_url` - URL válida para receber os webhooks

## Compatibilidade

Esta implementação é compatível com a API UltraMsg versão mais recente e segue as especificações documentadas em:
- Endpoint UltraMsg: `GET /{instance_id}/messages`
- Endpoint UltraMsg: `GET /{instance_id}/messages/statistics`