# Configuração do Token no Webhook Z-API

**Importante:** O POST do webhook **exige** o token `ZAPI_WEBHOOK_TOKEN` para maior segurança.

## Como configurar na Z-API

No painel da Z-API, ao configurar a URL do webhook, inclua o token como parâmetro:

```
https://seu-dominio.com/webhooks/zapi?token=SEU_ZAPI_WEBHOOK_TOKEN
```

Ou use os caminhos alternativos:
```
https://seu-dominio.com/webhooks/zapi/connection?token=SEU_ZAPI_WEBHOOK_TOKEN
https://seu-dominio.com/webhooks/zapi/status?token=SEU_ZAPI_WEBHOOK_TOKEN
```

O valor de `SEU_ZAPI_WEBHOOK_TOKEN` deve ser **idêntico** ao configurado no `.env` do backend:

```
ZAPI_WEBHOOK_TOKEN=seu_token_secreto_aqui
```

## Formatos aceitos

1. **Query string:** `?token=xxx` (recomendado para Z-API)
2. **Header:** `X-Webhook-Token: xxx`
3. **Header:** `Authorization: Bearer xxx`

## Atenção para instâncias já configuradas

Se a Z-API já estava configurada **antes** desta alteração, a URL do webhook **não** incluía o token. O webhook passará a rejeitar com 401 até que você:

1. Adicione `?token=VALOR_DO_ZAPI_WEBHOOK_TOKEN` à URL no painel Z-API
2. Ou configure o header `X-Webhook-Token` (se a Z-API suportar headers customizados)

## Validação

- Token ausente → 401 "Token do webhook ausente"
- Token inválido → 401 "Token do webhook inválido"
- Comparação em tempo constante (timing-safe) para prevenir ataques
