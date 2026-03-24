# Prompt para o frontend — modal “Novo contato” (ZapERP / WhatsApp)

Use este texto como briefing de produto + implementação para o time de frontend alinhar UI ao backend.

---

## Objetivo

Deixar o fluxo **“Novo contato”** claro, **premium** e à prova de erro: o usuário precisa entender **como digitar o telefone** (formato aceito pelo WhatsApp/Brasil no backend) e receber **feedback imediato** quando o número for inválido ou vazio.

---

## API (backend já implementado)

- **Método/rota:** `POST /chats/contato` (ou `POST /api/chats/contato` conforme base URL do app)
- **Auth:** header `Authorization: Bearer <JWT>` (igual às demais rotas)
- **Body (JSON):**
  - `telefone` (string, **obrigatório**): número brasileiro; pode vir com máscara (`(11) 98765-4321`), `+55`, espaços etc.
  - `nome` (string, opcional): nome de exibição do cliente

### Sucesso (200)

- **Resposta:** objeto da **conversa** criada ou reutilizada (estrutura já usada na lista de chats).
- **Tempo real:** o backend pode emitir evento de **nova conversa** (`nova_conversa` no socket da empresa), como nas outras conversas.

### Erros (400) — usar para mensagens na UI

| `codigo`              | Quando |
|-----------------------|--------|
| `TELEFONE_OBRIGATORIO`| Campo vazio ou só espaços |
| `TELEFONE_INVALIDO`   | Não dá para normalizar como telefone BR válido; ou tentativa de grupo/LID |

O corpo inclui também:

- `error` — texto curto
- `detalhe` — explicação para o usuário
- `formato_esperado` — regra em linguagem natural
- `exemplos` — array de strings para exibir como exemplos aceitos

Exibir **preferencialmente** `detalhe` + uma linha com **um** exemplo da lista (ex.: `34999999999` ou `(34) 99999-9999`).

---

## Regra de negócio (formato do número)

O backend aceita **somente números brasileiros** normalizados para armazenamento:

- **DDD + número** com **10 ou 11 dígitos** (sem contar o 55) → o sistema adiciona `55` se faltar.
- Ou **já com `55`** no início → **12 ou 13 dígitos** no total (`55` + DDD + fixo 8 dígitos ou celular 9 dígitos).

Caracteres não numéricos são **ignorados** na normalização. Números de **outros países** ou strings aleatórias não são aceitos neste formulário.

---

## Direção visual e UX (“premium”, profissional)

1. **Título e subtítulo:** “Novo contato” + uma linha curta: *“Digite o número com DDD. O sistema aceita com ou sem máscara.”*
2. **Campo telefone:**
   - Placeholder sugestivo: `Ex.: (11) 98765-4321` ou `+55 11 98765-4321`
   - **Máscara opcional** (BR) enquanto digita; **antes de enviar**, pode enviar o valor cru ou só dígitos — o backend aceita ambos.
   - **Texto de ajuda** abaixo do campo (sempre visível ou em tooltip “?”): copiar/adaptar `formato_esperado` + um exemplo dos `exemplos` de erro 400.
3. **Validação no cliente:** se possível, validar `telefone` vazio antes do POST; para formato, confiar no **400** (ou regex simples: após remover `\D`, esperar 10–11 dígitos ou 12–13 começando com `55`).
4. **Erro de API:** toast ou alerta inline com `detalhe`; não mostrar só “Erro 400”.
5. **Estética:** modal com hierarquia clara (título, campos, ajuda, CTA primário), **contraste** adequado, ícone de telefone/contato no label, botão CTA com estado de loading e disabled durante submit.
6. **Acessibilidade:** `aria-describedby` ligando o input ao texto de ajuda; foco no primeiro campo ao abrir.

---

## Checklist de aceite

- [ ] Usuário vê **como** digitar o telefone antes de errar.
- [ ] Envio com número válido BR cria conversa e lista atualiza (REST refetch ou socket).
- [ ] Resposta 400 mostra mensagem **amigável** usando `detalhe` / `codigo`.
- [ ] Layout consistente com o restante do app (dark mode, se aplicável).
