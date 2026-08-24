# API de Encaminhamento de Mensagens

## Endpoint

```
POST /chats/:id/encaminhar
```

## Descrição

Encaminha uma ou várias mensagens (texto, mídia, áudio, arquivo, etc.) de uma conversa para outra conversa, na ordem enviada.

## Parâmetros da URL

- `id`: ID da conversa de destino

## Corpo da Requisição

**Uma mensagem (compatível):**

```json
{
  "mensagem_id": "123",
  "tipo_encaminhamento": "auto"
}
```

**Várias mensagens (lote, mesma ordem do array):**

```json
{
  "mensagem_ids": [101, 102, 103],
  "tipo_encaminhamento": "auto"
}
```

Limite: até **30** IDs por requisição. Duplicados no array são ignorados.

### Campos

- `mensagem_id` ou `mensagem_ids` (**obrigatório um dos dois**): ID único ou lista de IDs das mensagens originais
- `tipo_encaminhamento` (opcional): Tipo de encaminhamento
  - `"auto"` (padrão): Detecta automaticamente o melhor método
  - `"texto"`: Força encaminhamento como texto
  - `"midia"`: Força encaminhamento como mídia (se possível)

## Tipos de Mensagem Suportados

### 1. Texto
- Encaminhado com prefixo `[Encaminhado]`
- Mantém formatação original

### 2. Imagem
- Encaminhada como imagem com caption `[Encaminhado] — Nome do Usuário`
- Preserva qualidade original

### 3. Vídeo
- Encaminhado como vídeo com caption
- Preserva qualidade original

### 4. Áudio
- Encaminhado como áudio normal
- Mantém formato original

### 5. Voice (Áudio de Voz)
- Encaminhado como voice note (PTT)
- Fallback para áudio normal se necessário

### 6. Arquivo/Documento
- Encaminhado como documento
- Preserva nome do arquivo original
- Adiciona caption com indicação de encaminhamento

### 7. Sticker/Figurinha
- Encaminhado como sticker
- Mantém formato original

### 8. Contato
- Encaminha informações do contato (vCard)
- Preserva todos os dados do contato

### 9. Localização
- Encaminha coordenadas e endereço
- Mantém precisão da localização

## Resposta de Sucesso

**Encaminhamento único** — mesmo formato de antes:

```json
{
  "success": true,
  "mensagem": {
    "id": 456,
    "conversa_id": 789,
    "texto": "[Encaminhado]\nTexto da mensagem original",
    "tipo": "texto",
    "status": "sent",
    "whatsapp_id": "wamid.xxx",
    "criado_em": "2026-03-26T10:30:00.000Z"
  },
  "enviado_whatsapp": true
}
```

**Encaminhamento em lote** (`mensagem_ids` com 2+ itens):

```json
{
  "success": true,
  "total": 3,
  "encaminhamentos": [
    { "mensagem_id": 101, "ok": true, "mensagem": { "id": 501, "tipo": "texto" }, "enviado_whatsapp": true },
    { "mensagem_id": 102, "ok": true, "mensagem": { "id": 502, "tipo": "audio" }, "enviado_whatsapp": true },
    { "mensagem_id": 103, "ok": false, "error": "URL da mídia não pode ser resolvida para encaminhamento", "status": 400 }
  ]
}
```

`success` é `true` apenas se **todos** os itens tiverem `ok: true`. Itens com falha não impedem o processamento dos demais.

## Resposta de Erro

```json
{
  "error": "Mensagem original não encontrada"
}
```

## Códigos de Status

- `200`: Sucesso
- `400`: Dados inválidos ou mensagem não encontrada
- `401`: Não autorizado
- `403`: Sem permissão para enviar mensagens nesta conversa
- `404`: Conversa de destino não encontrada
- `500`: Erro interno do servidor

## Exemplo de Uso (JavaScript)

```javascript
// Encaminhar uma mensagem
async function encaminharMensagem(conversaDestinoId, mensagemId) {
  try {
    const response = await fetch(`/api/chats/${conversaDestinoId}/encaminhar`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        mensagem_id: mensagemId,
        tipo_encaminhamento: 'auto'
      })
    });

    const data = await response.json();
    
    if (data.success) {
      console.log('Mensagem encaminhada com sucesso:', data.mensagem);
      return data.mensagem;
    } else {
      throw new Error(data.error);
    }
  } catch (error) {
    console.error('Erro ao encaminhar mensagem:', error);
    throw error;
  }
}

// Uso
encaminharMensagem(123, 456)
  .then(mensagem => {
    console.log('Encaminhamento realizado:', mensagem);
  })
  .catch(error => {
    console.error('Falha no encaminhamento:', error);
  });
```

## Comportamento Especial

### Resolução de URLs de Mídia

O sistema automaticamente resolve URLs de mídia baseado na configuração:

1. **APP_URL configurado**: Usa URL completa (`https://app.com/uploads/file.jpg`)
2. **Localhost/desenvolvimento**: Faz upload para CDN do UltraMsg
3. **Arquivo não acessível**: Converte para base64 (fallback)

### Tratamento de Erros de Mídia

Se o encaminhamento como mídia falhar, o sistema automaticamente:

1. Tenta novamente com formato alternativo
2. Faz fallback para encaminhamento como texto
3. Inclui URL da mídia no texto como backup

### Prefixo de Encaminhamento

Todas as mensagens encaminhadas recebem o prefixo `[Encaminhado]` para:

1. Identificar claramente mensagens encaminhadas
2. Seguir padrões do WhatsApp
3. Evitar confusão sobre autoria

### Nome do Usuário

Quando configurado (`mostrar_nome_ao_cliente = true`), o nome do usuário é adicionado:

- **Texto**: `[Encaminhado]\nTexto original\n— João Silva`
- **Mídia**: Caption com `[Encaminhado] — João Silva`
- **Localização**: Endereço prefixado com `João Silva — Endereço`

## Limitações

1. **Mensagens muito antigas**: Podem não ter URLs de mídia válidas
2. **Arquivos grandes**: Limitados pelo provider WhatsApp (16-32MB)
3. **Formatos não suportados**: Convertidos automaticamente ou enviados como texto
4. **Conversas LID**: Requer resolução de telefone real antes do envio

## Logs e Debugging

O sistema registra logs detalhados para debugging:

```
✅ WhatsApp mídia enviada: +5511999999999 imagem (wamid.xxx)
❌ WhatsApp: falha ao enviar mídia para +5511999999999 video sem detalhes
[ULTRAMSG] Upload bem-sucedido, enviando mídia via CDN: https://cdn.ultramsg.com/...
[ULTRAMSG] Áudio enviado via base64 como audio/ogg (fallback CDN falhou)
```

## Integração com Frontend

Para integrar com o frontend React existente, atualize a função `encaminharArquivo` em `conversaService.js`:

```javascript
export async function encaminharArquivo(conversaId, mensagem, getMediaUrl) {
  const response = await api.post(`/chats/${conversaId}/encaminhar`, {
    mensagem_id: mensagem.id,
    tipo_encaminhamento: 'auto'
  });
  
  return response.data.mensagem;
}
```