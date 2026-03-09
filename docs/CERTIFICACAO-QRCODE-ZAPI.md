# Certificação — QR Code Z-API (Conectar WhatsApp)

## Resumo

O backend **está correto** ao obter o QR Code da Z-API. O fluxo segue a documentação oficial da Z-API e implementa throttling conforme as recomendações.

O erro **429 Too Many Requests** na tela "Conectar WhatsApp" vem do **nosso backend** (rate limit/throttle), não da Z-API. É intencional para evitar loop de chamadas sem o usuário escanear.

---

## 1. Fluxo no backend

### Rotas

| Método | Rota | Handler |
|--------|------|---------|
| GET | `/integrations/zapi/connect/qrcode` | `getQrCode` |
| POST | `/integrations/zapi/connect/qrcode` | `getQrCode` |

Base: `GET/POST /api/integrations/zapi/connect/qrcode` (com prefixo `/api` se configurado).

### Sequência em `getQrCode`

1. **checkCompanyRate**: máx. 10 chamadas/minuto por empresa → se exceder → 429
2. **getStatus**: se já conectado → `{ connected: true }`
3. **checkGuard**: throttle 10s entre QRs; bloqueio 60s após 3 tentativas → se bloqueado → 429
4. **getQrCodeImage**: chama Z-API e retorna base64

---

## 2. Chamada à Z-API (assinatura)

### Endpoints oficiais (developer.z-api.io)

| Método | Endpoint Z-API | Retorno |
|--------|----------------|---------|
| GET | `/instances/{instance_id}/token/{instance_token}/qr-code/image` | Imagem base64 |
| GET | `/instances/{instance_id}/token/{instance_token}/qr-code` | Bytes do QR Code |

### Headers

| Header | Valor |
|--------|-------|
| `Client-Token` | Token de segurança da conta (quando `empresa_zapi.client_token` existe) |
| `Accept` | `application/json` (para `/qr-code/image`) |

### Implementação (`zapiIntegrationService.js`)

1. **Primeira tentativa**: `GET {base}/qr-code/image`
   - Aceita JSON com: `qrCodeBase64`, `qrCode`, `qr`, `image`, `imageBase64`
   - Aceita `text/plain` com base64 puro
2. **Fallback**: `GET {base}/qr-code`
   - Converte bytes → base64 com `Buffer.from(buf).toString('base64')`

### URL base

```txt
{ZAPI_BASE_URL}/instances/{instance_id}/token/{instance_token}
```

`ZAPI_BASE_URL` padrão: `https://api.z-api.io` (configurável em `.env`).

---

## 3. Rate limits (por que aparece 429)

### Limites do backend

| Camada | Limite | Janela | Efeito |
|--------|--------|--------|--------|
| checkCompanyRate | 10 chamadas | 60 s | 429 `retryAfterSeconds: 60` |
| checkGuard (throttle) | 1 chamada | 10 s | 429 `retryAfterSeconds` 1–10 |
| checkGuard (bloqueio) | 3 tentativas sem conectar | - | 429 `retryAfterSeconds: 60` |

### Recomendações Z-API (seguidas)

- Chamar API em **intervalos de 10–20 s** para novo QR — usamos 10 s (THROTTLE_SECONDS)
- Após **3 chamadas** sem leitura, interromper e pedir ação do usuário — usamos bloqueio de 60 s

### Resposta 429 do backend

```json
{
  "error": "throttled" | "blocked",
  "retryAfterSeconds": 60,
  "attemptsLeft": 0
}
```

O frontend deve exibir "Pode tentar novamente em Xs" usando `retryAfterSeconds`.

---

## 4. Respostas de sucesso

### Já conectado

```json
{ "connected": true }
```

### QR disponível

```json
{
  "connected": false,
  "qrBase64": "<base64 puro>",
  "nextRefreshSeconds": 10,
  "attemptsLeft": 2
}
```

Uso no frontend: `src={"data:image/png;base64," + qrBase64}`

---

## 5. Outros códigos

| Código | Situação |
|--------|----------|
| 401 | Não autenticado |
| 404 | Empresa sem instância Z-API configurada |
| 409 | `needsRestore: true` — sessão precisa ser restaurada |
| 429 | Throttle/bloqueio (ver acima) |
| 502 | Falha ao chamar Z-API ou erro interno |

---

## 6. Checklist de certificação

- [x] `getQrCodeImage` chama `/qr-code/image` primeiro
- [x] Fallback para `/qr-code` (bytes → base64)
- [x] `Client-Token` enviado quando configurado
- [x] Aceita múltiplos formatos de resposta (qrCodeBase64, qrCode, qr, etc.)
- [x] Tratamento de `already connected` e `restore session`
- [x] Throttle 10 s entre QRs (Z-API recomenda 10–20 s)
- [x] Bloqueio após 3 tentativas sem conectar (Z-API recomenda parar após 3)
- [x] 429 com `retryAfterSeconds` para o frontend exibir countdown

---

## Referência

- [Z-API — Pegar QRCode](https://developer.z-api.io/instance/qrcode)
- `services/zapiIntegrationService.js` — `getQrCodeImage`
- `controllers/zapiIntegrationController.js` — `getQrCode`
- `services/zapiConnectGuardService.js` — throttle e bloqueio
