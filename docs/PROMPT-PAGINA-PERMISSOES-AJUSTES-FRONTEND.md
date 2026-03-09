# Prompt: Ajustes na Página de Permissões — Correção Completa

Este documento descreve os ajustes realizados na página de Permissões para garantir que **todos os campos de permissão apareçam ao selecionar um usuário**, com implementação completa e profissional.

---

## Problema identificado

Na aba "Permissões" (Configurações > Permissões), ao selecionar um usuário, **não apareciam os campos para configurar permissões**. Apenas o seletor de usuário e os botões "Restaurar padrão" e "Salvar" eram exibidos.

**Causa raiz:**
1. O `getCatalogoPermissoes()` retornava o objeto completo da API `{ catalogo, flat }` em vez de usar `data.catalogo`
2. A função `normalizarCatalogo()` esperava `raw.categorias`, mas o backend retorna `raw.catalogo`
3. O mapeamento de permissões do usuário usava campos incorretos (`valor`, `valor_efetivo`) em vez de `concedido` e `isOverride`
4. O `putPermissoesUsuario` enviava array `[{ codigo, valor }]` em vez do objeto `{ codigo: boolean|null }` exigido pelo backend
5. "Restaurar padrão" apenas zerava o estado local sem chamar a API
6. JSX malformado com fechamentos incorretos

---

## Ajustes implementados

### 1. **permissoesService.js**

```javascript
// getCatalogoPermissoes: retorna data.catalogo (array) em vez do objeto inteiro
return data?.catalogo ?? data ?? [];

// putPermissoesUsuario: recebe objeto { codigo: true|false|null }, não array
export async function putPermissoesUsuario(id, permissoesObj) {
  const { data } = await api.put(`/usuarios/${id}/permissoes`, {
    permissoes: permissoesObj,
  });
  return data || {};
}
```

### 2. **normalizarCatalogo() em SecaoPermissoes.jsx**

Agora suporta o formato do backend:

- `{ catalogo: [{ categoria, permissoes: [...] }] }` — formato principal do backend
- `{ categorias: [{ nome, permissoes: [...] }] }` — formato alternativo
- Array plano `[{ codigo, nome, categoria }]`

Mantém `descricao` para exibir tooltip/ajuda em cada permissão.

### 3. **loadUsuarioPermissoes()**

Mapeamento correto dos dados do backend:

- `concedido` (boolean) → valor efetivo
- `isOverride` (boolean) → indica se há override; quando true, define `localOverrides[codigo]` como `VALOR_GRANT` ou `VALOR_DENY`
- Armazena `usuario` em `usuarioInfo` para exibir nome, email, perfil e setor

### 4. **handleSalvar()**

Constrói o payload no formato esperado pelo backend:

```javascript
const payload = {};
for (const [codigo, valor] of Object.entries(localOverrides)) {
  if (valor === VALOR_GRANT) payload[codigo] = true;
  else if (valor === VALOR_DENY) payload[codigo] = false;
  else if (valor === VALOR_DEFAULT) payload[codigo] = null;
}
await putPermissoesUsuario(usuarioId, payload);
```

### 5. **handleRestaurarPadrao()**

- Chama a API enviando `null` para todas as permissões em override
- Confirmação antes de executar
- Recarrega as permissões após sucesso

### 6. **Informações do usuário**

Bloco exibido ao selecionar um usuário:

- Nome, e-mail, perfil e setor (quando disponível)

### 7. **PermissaoRow**

- Recebe e exibe `descricao` abaixo do nome
- Mantém os três estados visuais: Padrão, Conceder, Negar

### 8. **Correção de JSX**

- Corrigidos fechamentos de tags e parênteses na estrutura de `grupos.map` e `permissoes.map`

---

## Formato das APIs (resumo)

| Endpoint | Método | Body / Resposta |
|----------|--------|-----------------|
| `/config/permissoes/catalogo` | GET | `{ catalogo: [{ categoria, permissoes: [{ codigo, nome, descricao, categoria }] }] }` |
| `/usuarios/:id/permissoes` | GET | `{ usuario: {...}, permissoes: [{ codigo, nome, concedido, isOverride }] }` |
| `/usuarios/:id/permissoes` | PUT | Body: `{ permissoes: { "codigo": true\|false\|null } }` |

- `true` = concede (override)
- `false` = nega (override)
- `null` = remove override (usa padrão do perfil)

---

## Resultado final

Ao selecionar um usuário na aba Permissões:

1. Aparece o card com nome, e-mail, perfil e setor
2. Os botões "Restaurar padrão" e "Salvar" são habilitados conforme o contexto
3. As permissões são listadas por categoria (Clientes, Atendimentos, Configurações, IA/Chatbot, Dashboard, Usuários, Integrações, Tags)
4. Cada permissão exibe três opções: Padrão, Conceder, Negar
5. A descrição de cada permissão é exibida para orientar o administrador
6. Overrides ficam destacados visualmente
7. Salvar e Restaurar padrão funcionam corretamente com a API

---

## Arquivos modificados

- `frontend/src/api/permissoesService.js`
- `frontend/src/pages/SecaoPermissoes.jsx`

A página está integrada em Configurações > Permissões e também acessível via `/permissoes` quando configurado nas rotas.
