# Prompt Frontend — Envio de Arquivo e Áudio

Valide e corrija o envio de arquivos (imagens, áudios, documentos, vídeos) para o chat.

---

## 1. Endpoint

| Método | URL | Autenticação |
|--------|-----|--------------|
| POST | `/api/chats/:id/arquivo` | Bearer JWT (obrigatório) |

**Exemplo:** `POST https://seudominio.com/api/chats/468/arquivo`

O `:id` é o **ID da conversa** (ex.: 468).

---

## 2. Formato obrigatório

- **Content-Type:** `multipart/form-data` (o navegador define automaticamente ao usar FormData)
- **Campo do arquivo:** qualquer nome (`file`, `audio`, `recording`, etc.) — o backend aceita todos
- **Recomendado:** use `file` para arquivos gerais e `audio` para gravação de voz

---

## 3. Exemplo correto (fetch)

```javascript
async function enviarArquivo(conversaId, arquivo) {
  const formData = new FormData()
  formData.append('file', arquivo, arquivo.name || 'audio.webm')
  // OU para gravação de voz: formData.append('audio', blob, 'audio.webm')

  const token = localStorage.getItem('token') // ou seu método de obter o token
  const res = await fetch(`/api/chats/${conversaId}/arquivo`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
    body: formData,
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || 'Falha ao enviar arquivo')
  }

  return res.json() // { ok: true, id, conversa_id }
}
```

---

## 4. Exemplo correto (axios)

```javascript
async function enviarArquivo(conversaId, arquivo) {
  const formData = new FormData()
  formData.append('file', arquivo, arquivo.name || 'audio.webm')

  // IMPORTANTE: NÃO definir Content-Type manualmente. O axios faz isso ao enviar FormData.
  const { data } = await api.post(`/chats/${conversaId}/arquivo`, formData, {
    headers: {
      'Content-Type': 'multipart/form-data', // ⚠️ REMOVA isto se estiver causando erro
    },
  })
  return data
}
```

### Regra importante com axios

**Não defina `Content-Type: multipart/form-data` manualmente.** O axios (e o navegador) precisa incluir o `boundary` no header. Ao omitir o header, o axios define:

```
Content-Type: multipart/form-data; boundary=----WebKitFormBoundary...
```

Se definir só `Content-Type: multipart/form-data` sem o boundary, o backend não consegue interpretar o corpo.

```javascript
// ✅ CORRETO — não passar headers ou passar apenas Authorization
await api.post(`/chats/${conversaId}/arquivo`, formData, {
  headers: { 'Authorization': `Bearer ${token}` },
})

// ❌ ERRADO — pode quebrar o upload
await api.post(`/chats/${conversaId}/arquivo`, formData, {
  headers: { 'Content-Type': 'multipart/form-data' },
})
```

---

## 5. Gravação de voz (MediaRecorder)

```javascript
function enviarAudioGravado(conversaId, blob) {
  const formData = new FormData()
  // Use 'audio' ou 'file' — ambos funcionam
  const extensao = blob.type?.includes('ogg') ? 'ogg' : 'webm'
  formData.append('audio', blob, `recording.${extensao}`)

  return fetch(`/api/chats/${conversaId}/arquivo`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
    body: formData,
  }).then(r => r.json())
}
```

---

## 6. Input de arquivo (file input)

```javascript
const input = document.querySelector('input[type="file"]')
input.addEventListener('change', async (e) => {
  const arquivo = e.target.files[0]
  if (!arquivo) return

  const formData = new FormData()
  formData.append('file', arquivo)

  await fetch(`/api/chats/${conversaId}/arquivo`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
    body: formData,
  })
})
```

---

## 7. Tipos de arquivo aceitos

| Categoria | Extensões / MIME |
|-----------|------------------|
| Imagens | jpg, png, webp, gif, bmp |
| Áudio | mp3, ogg, wav, m4a, webm, opus, aac |
| Vídeo | mp4, webm, mov, avi, 3gp |
| Documentos | pdf, doc, docx, xls, xlsx, ppt, pptx, txt, csv, zip |

Tamanho máximo: **32 MB**.

---

## 8. Checklist de validação

- [ ] Usa `FormData` para montar o corpo da requisição
- [ ] Não define `Content-Type` manualmente (exceto para excluir headers customizados)
- [ ] Envia o token JWT em `Authorization: Bearer <token>`
- [ ] Usa `formData.append('file', arquivo)` ou `formData.append('audio', blob)`
- [ ] Inclui nome do arquivo no `append` quando disponível: `append('file', blob, 'audio.webm')`
- [ ] Trata erro 400 com mensagem amigável ao usuário

---

## 9. Erros comuns e soluções

| Erro | Causa | Solução |
|------|-------|---------|
| "Arquivo não enviado. Envie multipart/form-data..." | Corpo não é FormData ou Content-Type incorreto | Usar FormData e não definir Content-Type manualmente |
| 401 Unauthorized | Token ausente ou inválido | Incluir `Authorization: Bearer <token>` |
| CORS | API em outro domínio sem CORS configurado | Verificar CORS no backend para o domínio do frontend |
| "Tipo de arquivo não permitido" | MIME não aceito | Verificar se o tipo está na lista (seção 7) |

---

## 10. Resposta de sucesso

```json
{
  "ok": true,
  "id": 12345,
  "conversa_id": 468
}
```

A mensagem é enviada via Socket.IO (`nova_mensagem`) — não vem no corpo da resposta. Atualize a UI ao receber o evento `nova_mensagem`.
