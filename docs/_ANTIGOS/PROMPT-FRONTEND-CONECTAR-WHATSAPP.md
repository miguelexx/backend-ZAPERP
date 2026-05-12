# PROMPT COMPLETO PARA O CURSOR (FRONTEND) — Tela Conectar WhatsApp

Cole este prompt no Cursor ao trabalhar no projeto **frontend** para implementar ou ajustar a tela "Conectar WhatsApp".

---

## CONTEXTO

O backend já está 100% pronto com as rotas `/integrations/zapi/connect/*` (também disponíveis em `/api/integrations/zapi/connect/*`). Todas as rotas exigem autenticação (Bearer token no header).

## CONTRATO DE API (OBRIGATÓRIO)

### 1) GET /integrations/zapi/connect/status
- **Sempre retorna 200** (nunca 404)
- **Payload:**
```json
{
  "hasInstance": boolean,
  "connected": boolean,
  "smartphoneConnected": boolean,
  "needsRestore": boolean,
  "error": string | null,
  "meSummary": {
    "id"?: string,
    "name"?: string,
    "due"?: number,
    "paymentStatus"?: string,
    "connected"?: boolean,
    "phone"?: string,
    "connectedCallbackUrl"?: string,
    "deliveryCallbackUrl"?: string,
    "disconnectedCallbackUrl"?: string,
    "messageStatusCallbackUrl"?: string,
    "presenceChatCallbackUrl"?: string,
    "receivedCallbackUrl"?: string,
    "initialDataCallbackUrl"?: string,
    "receiveCallbackSentByMe"?: boolean,
    "callRejectAuto"?: boolean,
    "callRejectMessage"?: string,
    "autoReadMessage"?: boolean
  } | null
}
```

### 2) POST ou GET /integrations/zapi/connect/qrcode

| Situação | HTTP | Payload |
|----------|------|---------|
| Conectado | 200 | `{ "connected": true }` |
| Precisa restore | 409 | `{ "needsRestore": true }` |
| QR ok | 200 | `{ "connected": false, "qrBase64": "<base64 puro>", "nextRefreshSeconds": 10, "attemptsLeft": 0..3 }` |
| Throttle/bloqueio | 429 | `{ "error": "throttled" \| "blocked", "retryAfterSeconds": number, "attemptsLeft": 0..3 }` |

**IMPORTANTE:** `qrBase64` é **base64 puro** (sem prefixo). Para renderizar:
```jsx
<img src={`data:image/png;base64,${qrBase64}`} alt="QR Code" />
```

### 3) POST /integrations/zapi/connect/restart
- **200** com o **mesmo contrato do /status** (hasInstance, connected, smartphoneConnected, needsRestore, error, meSummary)

### 4) POST /integrations/zapi/connect/phone-code
- **Body:** `{ "phone": "11999999999" }`
- **200:** `{ "code": "123456" }` (ou campo retornado pela Z-API)
- **400:** phone inválido (10–13 dígitos BR)

---

## REQUISITOS DA TELA "CONECTAR WHATSAPP"

### Ao abrir a tela
1. Chamar `GET /integrations/zapi/connect/status`
2. Tratar estados:
   - **hasInstance=false** → Mostrar: "Sua empresa ainda não tem instância configurada. Contate o suporte."
   - **needsRestore=true** → Mostrar aviso + botão "Reiniciar instância" que chama `POST /connect/restart` e depois recarrega o status
   - **connected=true** → Mostrar "WhatsApp conectado" + `smartphoneConnected` + dados básicos do `meSummary` (name, due, paymentStatus)
   - **Não conectado** → Mostrar painel de QR

### Painel QR
- **Botão "Gerar QR Code"**
  - Chama `POST /integrations/zapi/connect/qrcode`
  - Se 200 com `qrBase64`: renderizar em `<img src={"data:image/png;base64," + qrBase64} />`
- **Atualização automática**
  - Após gerar, iniciar timer para chamar `/connect/qrcode` a cada `nextRefreshSeconds` (10–20s)
  - **NÃO** fazer loop infinito: respeitar 429 (parar timer e mostrar botão "Tentar novamente")
  - Após 3 tentativas/bloqueio: parar e exigir clique manual
- **429 (throttle/blocked)**
  - Mostrar contador com `retryAfterSeconds`
  - Botão "Tentar novamente" habilita após o tempo ou quando o contador chegar a 0
- **409 needsRestore**
  - Parar timer
  - Trocar UI para tela de restore (aviso + botão Reiniciar)
- **Se /status voltar connected=true**
  - Parar timer imediatamente e mostrar "Conectado"

### Regras de consumo de tentativas (backend já implementado)
- **Não consome tentativas** quando:
  - `connected=true`
  - `needsRestore=true`
  - 429 (throttled por <10s ou bloqueado)
- Timer deve usar `nextRefreshSeconds` do response (10 ou 15)

### Extras obrigatórios
- **Não exibir tokens**, não salvar tokens no localStorage
- Evitar "carregando infinito": timeout visual e mensagens claras
- **401** → redirecionar para login
- UI simples e prática, estilo WhatsApp Web (QR central + instruções curtas)

---

## ARQUIVOS QUE PROVAVELMENTE SERÃO ALTERADOS

- `src/pages/*ConectarWhatsApp*` ou `src/pages/*Integracao*` ou similar
- `src/components/*Conectar*` ou `*QR*` ou `*WhatsApp*`
- `src/services/api.js` ou `src/api/*` — adicionar funções:
  - `getZapiConnectStatus()`
  - `getZapiConnectQrCode()`
  - `postZapiConnectRestart()`
  - `postZapiConnectPhoneCode(phone)`
- Rotas em `src/App.jsx` ou `src/routes/*` (se a rota não existir)

---

## EXEMPLO DE CHAMADAS API (fetch/axios)

```js
const API_BASE = import.meta.env.VITE_API_URL || '/api';

function getAuthHeaders() {
  const token = localStorage.getItem('token'); // ou seu store de auth
  return { Authorization: `Bearer ${token}` };
}

export async function getZapiConnectStatus() {
  const res = await fetch(`${API_BASE}/integrations/zapi/connect/status`, {
    headers: getAuthHeaders(),
  });
  if (res.status === 401) throw new Error('UNAUTHORIZED');
  return res.json();
}

export async function getZapiConnectQrCode() {
  const res = await fetch(`${API_BASE}/integrations/zapi/connect/qrcode`, {
    method: 'POST',
    headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
  });
  if (res.status === 401) throw new Error('UNAUTHORIZED');
  const data = await res.json();
  return { status: res.status, data };
}

export async function postZapiConnectRestart() {
  const res = await fetch(`${API_BASE}/integrations/zapi/connect/restart`, {
    method: 'POST',
    headers: getAuthHeaders(),
  });
  return res.json();
}

export async function postZapiConnectPhoneCode(phone) {
  const res = await fetch(`${API_BASE}/integrations/zapi/connect/phone-code`, {
    method: 'POST',
    headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone }),
  });
  return res.json();
}
```

---

## DIAGRAMA DE ESTADOS (simplificado)

```
[Carregando] → getConnectStatus()
    ↓
hasInstance=false → [Tela: Contate o suporte]
needsRestore=true → [Tela: Restore + Botão Reiniciar] → restart → recarrega status
connected=true → [Tela: Conectado + meSummary]
    ↓
connected=false → [Painel QR]
    ↓
[Gerar QR] → postQrcode()
    ↓
200 + qrBase64 → [Mostrar img + timer nextRefreshSeconds]
429 → [Contador retryAfterSeconds + Botão Tentar novamente]
409 → [Tela Restore]
200 + connected → [Parar timer → Tela Conectado]
```

---

## CHECKLIST DE IMPLEMENTAÇÃO

- [ ] Service/API client com as 4 funções acima
- [ ] Tratamento 401 → redirect login
- [ ] Estado hasInstance=false
- [ ] Estado needsRestore + botão Reiniciar + chamar restart + recarregar status
- [ ] Estado connected + exibir meSummary (name, due, paymentStatus)
- [ ] Painel QR com botão Gerar
- [ ] Imagem QR com `data:image/png;base64,` + qrBase64
- [ ] Timer de refresh com nextRefreshSeconds
- [ ] Parar timer em 429, 409 ou connected=true
- [ ] Contador visual em 429 com retryAfterSeconds
- [ ] Botão "Tentar novamente" após bloqueio/throttle
- [ ] Timeout e mensagens para evitar carregando infinito
- [ ] Nenhum token em tela ou localStorage
