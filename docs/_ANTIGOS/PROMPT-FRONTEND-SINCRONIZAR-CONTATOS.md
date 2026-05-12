# Prompt Frontend — Sincronizar Contatos (Correção)

## Problema atual

O frontend está chamando `POST /api/chats/sincronizar-contatos` **automaticamente ao carregar a página** (4 vezes), causando erros vermelhos no console do browser quando o WhatsApp não está conectado.

---

## O que corrigir

### 1. Nunca chamar `/sincronizar-contatos` automaticamente no carregamento

O endpoint **só deve ser chamado quando o usuário clicar explicitamente** no botão "Sincronizar Contatos". Remova qualquer `useEffect`, `onMount`, ou chamada automática a esse endpoint.

**Errado:**
```js
// NÃO FAZER — não chamar automaticamente
useEffect(() => {
  api.post('/chats/sincronizar-contatos')
}, [])
```

**Correto:**
```js
// Só chamar quando o usuário clicar
<button onClick={handleSincronizar}>Sincronizar contatos</button>
```

---

### 2. Tratar a resposta corretamente (verificar `ok` no body)

O backend agora sempre retorna **HTTP 200**. A falha é indicada pelo campo `ok: false` no corpo da resposta.

**Resposta de sucesso:**
```json
{
  "total_contatos": 120,
  "criados": 45,
  "atualizados": 75,
  "fotos_atualizadas": 0
}
```

**Resposta de falha (WhatsApp não conectado ou não configurado) — ainda HTTP 200:**
```json
{
  "ok": false,
  "message": "Conecte o WhatsApp via QR code antes de sincronizar.",
  "total_contatos": 0,
  "criados": 0,
  "atualizados": 0
}
```

**Implementação correta:**
```js
async function sincronizarContatos() {
  setSincronizando(true)
  try {
    const res = await api.post('/chats/sincronizar-contatos')
    const data = res.data

    if (data.ok === false) {
      // WhatsApp não conectado ou empresa sem instância configurada
      toast.warning(data.message || 'WhatsApp não está conectado. Conecte em Integrações.')
      return
    }

    toast.success(
      `Sincronização concluída: ${data.total_contatos} contatos, ${data.criados} novos, ${data.atualizados} atualizados.`
    )
  } catch (err) {
    // Erro de rede ou servidor
    toast.error('Erro ao sincronizar contatos. Tente novamente.')
  } finally {
    setSincronizando(false)
  }
}
```

---

### 3. Botão com estado de carregamento

```jsx
<button
  onClick={sincronizarContatos}
  disabled={sincronizando}
  className="btn btn-primary"
>
  {sincronizando ? 'Sincronizando...' : 'Sincronizar contatos'}
</button>
```

---

### 4. O que o endpoint faz (para contexto)

- Puxa os contatos da **agenda do celular** conectado via WhatsApp/UltraMsg
- Cria ou atualiza clientes na tabela `clientes` com nome e foto de perfil
- **Requisitos para funcionar:**
  1. Empresa tem WhatsApp configurado em Integrações
  2. WhatsApp está conectado (QR code escaneado)
- Só importa contatos **salvos na agenda** (com nome). Contatos de conversas sem nome salvo não são importados.

---

## Checklist

- [ ] Remover todas as chamadas automáticas a `/chats/sincronizar-contatos` no carregamento de componentes
- [ ] Só chamar quando o usuário clicar no botão
- [ ] Verificar `data.ok === false` antes de tratar como sucesso
- [ ] Exibir `data.message` quando `ok === false` (ex: "WhatsApp não conectado")
- [ ] Botão com estado `disabled` durante a requisição
- [ ] Toast/feedback de sucesso com contadores (`criados`, `atualizados`)
- [ ] Em caso de `ok === false`, redirecionar/informar o usuário para conectar o WhatsApp em Integrações
