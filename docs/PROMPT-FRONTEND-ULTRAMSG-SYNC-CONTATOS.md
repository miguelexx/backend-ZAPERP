# Prompt Frontend — Sincronizar Contatos (UltraMSG)

## Alterações necessárias na página de Integrações/Clientes

### 1. Trocar "Z-API" por "UltraMSG"

O sistema usa **UltraMSG** para integração WhatsApp. Atualize todos os textos que mencionam Z-API:

- **Antes:** "Atualize as fotos de perfil de todos os clientes a partir do WhatsApp **(Z-API)**."
- **Depois:** "Atualize as fotos de perfil de todos os clientes a partir do WhatsApp **(UltraMSG)**."

### 2. Remover bloqueio / aviso de "Conecte o WhatsApp via QR code"

O backend **não bloqueia mais** o sync por status de conexão. Ao clicar em "Sincronizar contatos do celular", a requisição é enviada e os contatos são puxados diretamente da API UltraMSG.

- **Remover** o texto de aviso que diz: "Conecte o WhatsApp via QR code antes de sincronizar. Os contatos são puxados exclusivamente da agenda do celular logado." — ou torná-lo apenas informativo (não bloqueante).
- O botão deve estar **sempre clicável** (não desabilitar com base em status de conexão).
- Se o sync falhar (ex.: WhatsApp desconectado), o backend retornará `ok: false` com `message` explicando o erro. Exiba essa mensagem ao usuário.

### 3. Endpoint de sync

O botão "Sincronizar contatos do celular" deve chamar:

```
POST /api/chats/sincronizar-contatos
```
ou
```
POST /api/integrations/whatsapp/contacts/sync
```

Ambos funcionam e usam UltraMSG.

### 4. Resposta esperada

**Sucesso:**
```json
{
  "ok": true,
  "total_contatos": 150,
  "criados": 20,
  "atualizados": 80,
  "mode": "contacts_api"
}
```

**Falha (ex.: sem instância configurada):**
```json
{
  "ok": false,
  "message": "Empresa sem instância WhatsApp configurada. Conecte o WhatsApp em Integrações."
}
```

Exiba a mensagem de sucesso ou erro conforme o retorno.
