# Revisão: Envio, Recebimento, Status e Dados em Tempo Real

## Fluxo Completo — Envio e Recebimento

### 1. Cliente envia mensagem (fromMe=false)
| Etapa | Onde | Ação |
|-------|------|------|
| Webhook | `POST /webhooks/zapi` | ReceivedCallback chega |
| Resolve | `resolveWebhookZapi` | instanceId → company_id |
| Cliente | `getOrCreateCliente` | Cria/atualiza com nome, pushname, foto do payload |
| Conversa | `findOrCreateConversation` | Uma conversa por telefone |
| Cache | `conversas` | Atualiza nome_contato_cache, foto_perfil_contato_cache |
| Mensagem | `mensagens` | INSERT com company_id, whatsapp_id |
| Socket | `nova_mensagem` | Emite para empresa_*, conversa_* |
| Socket | `conversa_atualizada` | Emite id, ultima_atividade, nome_contato_cache, contato_nome, foto_perfil |
| Background | `syncContactFromZapi` | Enriquece cliente via Z-API getContactMetadata + getProfilePicture |
| Socket | `contato_atualizado` | Emite conversa_id, contato_nome, foto_perfil |

### 2. Você envia pelo celular (fromMe=true)
| Etapa | Igual ao fluxo 1 | Payload traz chatName/chatPhoto (destino) |
|-------|------------------|------------------------------------------|
| Espelhamento | notifySentByMe | Z-API envia ReceivedCallback com fromMe=true |
| Destino | `resolvePeerPhone` | Resolve to/remoteJid = contato que recebeu |
| Resto | Idêntico | Cliente criado/atualizado, mensagem salva, sockets emitidos |

### 3. Você envia pelo CRM/sistema
| Etapa | Onde | Ação |
|-------|------|------|
| API | `POST /chats/:id/mensagens` | enviarMensagemChat |
| Cliente | Se conversa sem cliente_id | getOrCreateCliente com nome_contato_cache, foto_perfil_contato_cache |
| Background | setImmediate | syncContactFromZapi para enriquecer |
| Mensagem | INSERT | Salva em mensagens com status=pending |
| Socket | `nova_mensagem` | Emite antes do envio WhatsApp |
| Provider | zapi.sendText | Envia à Z-API |
| Update | mensagens | status=sent, whatsapp_id |
| Socket | `status_mensagem` | Emite mensagem_id, status, whatsapp_id |
| Webhook | DeliveryCallback | Atualiza status, emite status_mensagem |

### 4. Status (ticks ✓ ✓ ✓)
| Evento | Onde | Payload |
|--------|------|---------|
| DeliveryCallback | POST /webhooks/zapi | status=SENT/RECEIVED |
| MessageStatusCallback | POST /webhooks/zapi/status | status=READ/PLAYED |
| Update | mensagens.status | sent → delivered → read |
| Socket | `status_mensagem` | { mensagem_id, conversa_id, status, whatsapp_id } |

---

## Exibição: Lista e Cabeçalho

### Lista de conversas (GET /chats)
| Campo | Origem | Prioridade |
|-------|--------|------------|
| contato_nome | clientes.pushname \|\| clientes.nome | 1º |
| | conversas.nome_contato_cache | 2º |
| foto_perfil | clientes.foto_perfil | 1º |
| | conversas.foto_perfil_contato_cache | 2º |

### Cabeçalho da conversa (GET /chats/:id)
| Campo | Origem | Prioridade |
|-------|--------|------------|
| contato_nome / cliente_nome | clientes.pushname \|\| clientes.nome | 1º |
| | conversas.nome_contato_cache | 2º (fallback) |
| foto_perfil | clientes.foto_perfil | 1º |
| | conversas.foto_perfil_contato_cache | 2º (fallback) |

**Correção aplicada:** `detalharChat` passa a incluir `nome_contato_cache` e `foto_perfil_contato_cache` para o cabeçalho exibir o nome correto mesmo antes do cliente ser sincronizado.

---

## Eventos Socket — Contrato para o Frontend

| Evento | Payload | Uso |
|--------|---------|-----|
| `nova_mensagem` | { id, conversa_id, texto, direcao, status, whatsapp_id, ... } | Inserir mensagem na lista |
| `status_mensagem` | { mensagem_id, conversa_id, status, whatsapp_id } | Atualizar ticks por whatsapp_id |
| `conversa_atualizada` | { id, ultima_atividade, telefone, nome_contato_cache, contato_nome, foto_perfil } | Atualizar item na lista lateral; telefone garante nome+número fixos no cabeçalho |
| `contato_atualizado` | { conversa_id, contato_nome, telefone, foto_perfil } | Atualizar lista e cabeçalho após sync Z-API. **Cabeçalho deve exibir sempre nome + número (fixos)** |
| `atualizar_conversa` | { id } | Sinal para recarregar/atualizar conversa na lista |

---

## Checklist de Verificação

### Envio
- [ ] Mensagem do CRM chega no celular
- [ ] Ticks atualizam (✓ → ✓✓ → azul)
- [ ] Cliente criado/vinculado quando conversa não tinha cliente_id

### Recebimento
- [ ] Mensagem do cliente aparece em tempo real
- [ ] Nome e foto preenchidos na lista e no cabeçalho
- [ ] syncContactFromZapi enriquece em background

### Espelhamento (celular)
- [ ] Mensagem enviada pelo celular aparece no CRM
- [ ] Na conversa correta (to/destino)
- [ ] Sem criar conversa duplicada

### Status
- [ ] DeliveryCallback atualiza status
- [ ] MessageStatusCallback (READ) atualiza para azul
- [ ] Evento status_mensagem com whatsapp_id

### Dados corretos
- [ ] Lista: contato_nome = nome do WhatsApp (não telefone quando há nome)
- [ ] Cabeçalho: mesmo nome da lista
- [ ] Foto de perfil exibida quando disponível
