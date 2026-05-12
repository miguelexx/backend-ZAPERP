# Prompt para o frontend — localização no chat (ZapERP)

Use este texto como instrução para o time de frontend alinhar a UI ao backend já implementado.

---

## Provedor WhatsApp

**A API usada em produção é apenas [UltraMSG](https://ultramsg.com/)** (`services/providers/ultramsg.js`). O envio de localização do CRM para o contato usa o endpoint UltraMSG `POST /{instance_id}/messages/location` (`token`, `to`, `address`, `lat`, `lng`). O frontend não chama UltraMSG diretamente: só consome o backend (REST + Socket.IO).

---

## Contexto

O backend passou a persistir e emitir mensagens `tipo === 'location'` com metadados estruturados em `location_meta`, além de `url` (link Google Maps) e `texto` (pré-visualização legível). O fluxo em tempo real segue o mesmo padrão das outras mensagens (`nova_mensagem`, `conversa_atualizada` com `ultima_mensagem_preview`).

## Contrato de dados

### Campo `location_meta` (JSON, opcional mas recomendado)

Objeto com:

| Campo       | Tipo   | Obrigatório | Descrição                          |
|------------|--------|-------------|------------------------------------|
| `latitude` | number | sim*        | Latitude em graus decimais         |
| `longitude`| number | sim*        | Longitude em graus decimais        |
| `nome`     | string | não         | Nome do local (POI)                |
| `endereco` | string | não         | Endereço formatado                 |

\*Quando `location_meta` existe, `latitude` e `longitude` devem estar presentes e válidos.

### Outros campos da mensagem (já existentes)

- `tipo`: `'location'`
- `url`: link `https://www.google.com/maps?q=lat,lng` (fallback para abrir mapa)
- `texto`: linha única para preview (ex.: `Nome • Endereço` ou `(localização)`)

## API de envio (CRM → backend)

- **Método/rota:** `POST /chats/:id/localizacao` (com autenticação igual às demais rotas de chat)
- **Body (JSON):**
  - `lat` **ou** `latitude` — obrigatório
  - `lng` **ou** `longitude` — obrigatório
  - `nome` **ou** `name` **ou** `placeName` — opcional (nome do local)
  - `address` **ou** `endereco` — opcional (endereço)

**Resposta de sucesso (exemplo):**

```json
{
  "ok": true,
  "id": 12345,
  "conversa_id": 99,
  "location_meta": {
    "latitude": -19.5,
    "longitude": -44.0,
    "nome": "Padaria",
    "endereco": "Rua X, 100"
  },
  "status": "sent"
}
```

`status` pode ser `sent`, `erro` ou `pending` (ex.: sem telefone resolvido para envio ao WhatsApp). A mensagem completa para exibição deve continuar vindo do **socket** `nova_mensagem` (evitar duplicar com o body da API, como já fazem com texto).

## Tempo real (Socket.IO)

1. **`nova_mensagem`** — payload da mensagem inclui `tipo`, `location_meta`, `url`, `texto`, `direcao`, `status`, etc., no mesmo formato das mensagens carregadas pelo `GET /chats/:id`.
2. **`conversa_atualizada`** — quando aplicável, `ultima_mensagem_preview` pode trazer:
   - `tipo: 'location'`
   - `location_meta` (mesmo objeto)
   - `texto`, `criado_em`, `direcao`

Tratar `location` no preview da lista lateral de forma análoga a `contact` (ícone + texto curto, sem exibir JSON).

## UI sugerida no menu de anexos

- Adicionar item **“Localização”** ao menu flutuante (ícone de pin/mapa; cor coerente com os círculos existentes — por exemplo tom âmbar/laranja ou verde-água para diferenciar de Documento / Link / Câmera / Contato).
- Ao tocar: obter coordenadas (Geolocation API do browser ou fluxo nativo no app), opcionalmente nome/endereço (reverse geocode ou campos manuais), e chamar `POST /chats/:id/localizacao` com o body acima.

## Renderização na bolha do chat

- Se existir `location_meta.latitude` e `location_meta.longitude`: mostrar mapa estático ou iframe/link para `url`, e abaixo ou ao lado **nome** e **endereco** quando existirem.
- Se `location_meta` vier nulo (mensagens antigas): usar só `url` + `texto` como fallback.
- Manter o mesmo alinhamento de bolhas e ticks de status que as mensagens `out` já usam.

## Alinhamento com mensagens recebidas

Mensagens recebidas via **webhook UltraMSG** (localização enviada pelo cliente no WhatsApp) também podem trazer `location_meta` quando o payload incluir coordenadas e, se disponíveis, nome/endereço. O mesmo componente visual serve para `in` e `out`.
