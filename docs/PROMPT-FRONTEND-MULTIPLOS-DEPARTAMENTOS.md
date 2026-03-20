# Prompt Frontend — Múltiplos Departamentos por Usuário

## Contexto

O backend passou a suportar **múltiplos departamentos por usuário**. Um atendente pode pertencer a Comercial e Financeiro ao mesmo tempo, por exemplo. A API foi atualizada e o frontend precisa refletir isso.

---

## 1. API — Contratos

### GET /api/usuarios/me
Retorna o usuário logado com:
```json
{
  "id": 1,
  "nome": "João",
  "email": "joao@empresa.com",
  "perfil": "atendente",
  "departamento_id": 1,
  "departamento_ids": [1, 2],
  "mostrar_nome_ao_cliente": true
}
```
- `departamento_id`: primeiro departamento (compatibilidade)
- `departamento_ids`: array com todos os departamentos do usuário

### GET /api/usuarios
Lista usuários com:
```json
[
  {
    "id": 1,
    "nome": "João",
    "email": "joao@empresa.com",
    "perfil": "atendente",
    "ativo": true,
    "departamento_ids": [1, 2],
    "departamentos": [
      { "id": 1, "nome": "Comercial" },
      { "id": 2, "nome": "Financeiro" }
    ]
  }
]
```
- `departamento_ids`: array de IDs
- `departamentos`: array de objetos `{ id, nome }` para exibição

### POST /api/usuarios (criar usuário)
Aceita:
```json
{
  "nome": "João",
  "email": "joao@empresa.com",
  "senha": "123456",
  "perfil": "atendente",
  "departamento_ids": [1, 2],
  "ativo": true
}
```
- `departamento_ids`: array de IDs (obrigatório para múltiplos setores)
- Aceita também `departamento_id` (número único) para compatibilidade

### PUT /api/usuarios/:id (atualizar usuário)
Aceita:
```json
{
  "departamento_ids": [1, 2, 3]
}
```
- `departamento_ids`: array de IDs; pode ser `[]` para remover todos

### GET /api/dashboard/departamentos
Lista departamentos da empresa (já existente). Use para popular o multi-select.

---

## 2. Tarefas do Frontend

### 2.1 Página de Usuários (lista)
- Exibir os departamentos do usuário como badges ou texto separado por vírgula.
- Exemplo: `Comercial, Financeiro` em vez de apenas `Comercial`.

### 2.2 Formulário de Criar Usuário
- Trocar o select único de departamento por um **multi-select** (checkboxes ou select múltiplo).
- Opções vindas de `GET /api/dashboard/departamentos`.
- Enviar `departamento_ids` (array) no POST.
- Permitir nenhum departamento selecionado (usuário sem setor).

### 2.3 Formulário de Editar Usuário
- Mesmo multi-select de departamentos.
- Carregar valores atuais de `departamento_ids` ou `departamentos`.
- Enviar `departamento_ids` no PUT ao salvar.

### 2.4 Perfil do Usuário (GET /usuarios/me)
- Se houver exibição de setor, mostrar todos os departamentos (ex: "Comercial, Financeiro").
- Usar `departamento_ids` ou `departamentos` conforme disponível.

### 2.5 Página de Permissões
- Ao exibir dados do usuário, mostrar `departamento_ids` / `departamentos` se a API retornar.

---

## 3. Componente Sugerido — Multi-Select de Departamentos

```tsx
// Exemplo conceitual (React)
function DepartamentoMultiSelect({ value = [], onChange, departamentos }) {
  const handleToggle = (depId) => {
    const next = value.includes(depId)
      ? value.filter(id => id !== depId)
      : [...value, depId]
    onChange(next)
  }
  return (
    <div>
      <label>Departamentos</label>
      {departamentos?.map(dep => (
        <label key={dep.id}>
          <input
            type="checkbox"
            checked={value.includes(dep.id)}
            onChange={() => handleToggle(dep.id)}
          />
          {dep.nome}
        </label>
      ))}
    </div>
  )
}
```

---

## 4. Fluxo de Dados

1. **Carregar departamentos:** `GET /api/dashboard/departamentos` → lista de `{ id, nome }`
2. **Criar/Editar:** usuário seleciona N departamentos → enviar `departamento_ids: [1, 2, ...]`
3. **Exibir:** usar `departamentos` (objetos) ou mapear `departamento_ids` com a lista de departamentos para mostrar nomes

---

## 5. Validações

- `departamento_ids` pode ser array vazio (usuário sem setor).
- IDs devem existir em `departamentos` da empresa (backend valida via FK).
- Não enviar `departamento_id` isolado ao criar/editar; preferir sempre `departamento_ids`.

---

## 6. Login e Token

O JWT retornado no login inclui `departamento_ids`. O frontend não precisa alterar a lógica de autenticação; apenas use `departamento_ids` onde exibir ou filtrar por setor.

---

## 7. Checklist

- [ ] Trocar select único por multi-select na criação de usuário
- [ ] Trocar select único por multi-select na edição de usuário
- [ ] Exibir múltiplos departamentos na listagem de usuários
- [ ] Exibir múltiplos departamentos no perfil (se aplicável)
- [ ] Enviar `departamento_ids` em POST e PUT
- [ ] Tratar `departamento_ids` vazio (usuário sem setor)
