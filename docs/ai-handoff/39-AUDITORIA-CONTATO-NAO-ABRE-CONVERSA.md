# 39 — Auditoria: "Erro no servidor — Não foi possível localizar ou criar conversa"

> 2026-11-05 · auditoria **+ correção aplicada** (§7). **Nenhum dado escrito no banco.**
> Gatilho: tela de Atendimento, busca por "alessandro", clique num contato marcado
> **"Sem conversa"** → toast vermelho `Erro no servidor / Não foi possível localizar ou criar conversa`.
> Evidência: código em produção + reprodução executando os helpers reais (`parseAgendaContact`,
> `normalizePhoneBR`, `whatsappIdentityKey`).
> SQL de varredura: [`scripts/diagnostico_contato_nao_abre_conversa.sql`](../../scripts/diagnostico_contato_nao_abre_conversa.sql)
> Parente direto: [38 — endereço de destino corrompido pelo `55`](38-AUDITORIA-ENDERECO-DESTINO-CORROMPIDO.md).
> O doc 38 é o lado **aceita e corrompe**; este é o lado **rejeita e explode**. Mesmo helper.

---

## 1. Resumo em uma frase

O contato foi **cadastrado** com um telefone que o próprio sistema **não consegue normalizar**
(ex.: DDD com `0` na frente, ou número internacional): a importação aceita 10–15 dígitos
quaisquer, mas abrir a conversa só aceita o padrão BR — então o contato existe, aparece na busca,
é clicável, e **nunca** abre.

---

## 2. A cadeia exata, do clique ao toast

| # | Onde | O que acontece |
|---|---|---|
| 1 | `chatList.jsx:1766` `handleOpenClienteSemConversa` | clique na linha "Sem conversa" → `POST /chats/abrir-conversa` |
| 2 | `controllers/chat/contactController.js:389` `abrirConversaCliente` | acha o cliente, resolve a instância WhatsApp (OK) |
| 3 | `services/conversaAbrirClienteService.js:57` | chama `findOrCreateConversation(... isGroup:false)` — **sem `allowNonBR`** |
| 4 |  `helpers/conversationSync.js:1088` | `getCanonicalPhone(telefone)` devolve `''` |
| 5 |  `helpers/conversationSync.js:1092-1094` | `return null` + `console.warn('… não foi possível normalizar o phone')` |
| 6 | `conversaAbrirClienteService.js:72` | `!result?.conversa?.id` → `error: 'Não foi possível localizar ou criar conversa'` |
| 7 | `contactController.js:420` | `res.status(500)` |
| 8 | `frontend/src/api/http.js:170` | interceptor: todo 5xx vira toast **"Erro no servidor"** |

`findOrCreateConversation` só devolve `null` em **dois** pontos: telefone vazio (já barrado antes)
e **telefone que não normaliza**. Todo o resto do caminho lança exceção — e exceção apareceria no
toast com a mensagem do Postgres, não com esse texto. Logo o diagnóstico é fechado: **o telefone
gravado no contato não é um telefone BR válido para o sistema.**

### 2.1 O log que confirma no servidor

```
[getCanonicalPhone] Telefone inválido para BR, descartado: ****5514 digitos: 14
[findOrCreateConversation] [ensureConversaForCliente] não foi possível normalizar o phone: ****5514 (digitos: 14)
```

```bash
pm2 logs --lines 2000 --nostream | grep "não foi possível normalizar o phone"
```

Os 4 últimos dígitos + a contagem de dígitos identificam o contato sem expor o número (LGPD, doc 37).

---

## 3. A regra que rejeita (`helpers/phoneHelper.js:15`)

`normalizePhoneBR` aceita **só** isto:

| Forma | Exemplo | Resultado |
|---|---|---|
| 10 ou 11 dígitos | `34998265514` | vira `5534998265514` ✅ |
| `55` + 12 ou 13 dígitos | `5534998265514` | aceito como está ✅ |
| `120…` com 15+ dígitos | id de grupo | aceito como grupo ✅ |
| **qualquer outra coisa** | `034998265514` | **`''`** ❌ |

Medido rodando o helper real:

```
034998265514      dig=12  normBR=""               ❌
0413499826551     dig=13  normBR=""               ❌
55034998265514    dig=14  normBR=""               ❌
351912345678      dig=12  normBR=""               ❌   (Portugal)
5534998265514     dig=13  normBR="5534998265514"  ✅
```

---

## 4. Como um contato assim entra no banco (3 portas, todas abertas)

A assimetria é a falha: **gravar** aceita `^\d{10,15}$`; **abrir** exige padrão BR.

### 4.1 Sincronizar contatos da agenda — a porta mais provável

`services/contactSyncService.js:203` passa `allowNonBR: true`. Reprodução com o parser real
(`parseAgendaContact`), nomes fictícios:

| Como está salvo no celular | `clientes.telefone` gravado | dígitos | abre? |
|---|---|---|---|
| `+55 (034) 99826-5514` | `55034998265514` | 14 | ❌ 500 |
| `034 99826-5514` | `034998265514` | 12 | ❌ 500 |
| `0 41 34 9982-6551` (código de operadora) | `0413499826551` | 13 | ❌ 500 |
| `+351 912345678` | `351912345678` | 12 | ❌ 500 |
| `5534998265514@c.us` | `5534998265514` | 13 | ✅ |

Salvar número com **`0` na frente do DDD** é hábito comum no Brasil — numa agenda de escola isso
aparece às dezenas. Por isso o problema vem em bloco, não isolado.

### 4.2 Cadastro manual (`POST /clientes`, modal "Novo contato")

`controllers/clienteController.js:367` passa `allowNonBR: true` sempre, e o bloqueio em
`:344` só barra grupo/LID/sem-dígito: `getCanonicalPhoneAnyIntl('034998265514')` devolve o número,
então **o cadastro é aceito**. Com `abrir_conversa: true`, o `ensureConversaForCliente` falha
igual — mas ali a resposta é 200 com `conversa_aviso`, **sem toast vermelho**. O contato nasce,
some do radar, e só estoura quando alguém clica nele depois.

### 4.3 `POST /chats/contato` (`criarContato`)

É o único que **repassa** `allowNonBR` para `findOrCreateConversation`
(`contactController.js:538`). Ali a conversa chega a ser criada — e vira o caso do **doc 38**:
mensagem sai com ✓ e nunca é entregue, porque o endereço não existe no WhatsApp.

---

## 5. Por que o contato aparece **duplicado** na lista

Na tela, "Alessandro Mendes" aparece duas vezes: um com conversa (13:54) e um "Sem conversa".
A deduplicação da lista usa `whatsappIdentityKey`, que **não normaliza** o número quebrado:

```
5534998265514   → idKey "553498265514"      (contato real)
55034998265514  → idKey "55034998265514"    (contato quebrado)
```

Chaves diferentes ⇒ a lista entende que são duas pessoas. O mesmo vale para a busca de contatos
sem conversa (`conversationListController.js:1193`), que lista **qualquer** linha de `clientes`
sem checar se o telefone é utilizável. Daí o padrão da tela: pares nome-a-nome, um clicável e um
que explode.

---

## 6. O que NÃO é

- **Não** é queda do servidor, banco fora do ar ou timeout — o 500 é deliberado, vem de um `return`.
- **Não** é permissão, instância WhatsApp nem multi-número: a instância é resolvida **antes** e,
  se fosse esse o caso, a resposta seria 400 com o seletor de número.
- **Não** é a conversa aberta na tela (`5534999…`): aquela está íntegra; o toast é do clique na lista.
- **Não** apaga nada: nenhuma conversa ou mensagem foi perdida neste erro.

---

## 7. A correção aplicada (05/11, **não deployada**)

Princípio que guiou tudo: **nada que hoje funciona pode mudar de resultado.** A recuperação do
tronco roda só onde o sistema hoje já desiste, e cada ponto de escrita usa um auxiliar que
devolve vazio quando não há o que corrigir.

| # | Arquivo | O que mudou |
|---|---|---|
| 1 | `helpers/phoneHelper.js` — `normalizePhoneBR` | ramo novo **no fim** da função: `0`+DDD e `55`+`0`+DDD viram BR canônico. Como fica depois de todos os `return` existentes, só vê entrada que hoje devolve `''` |
| 2 | `helpers/phoneHelper.js` — `comDdiSeForBrValido` | guarda do ramo novo: só devolve `55` + DDD de 1–9 + 8/9 dígitos. Impede que a recuperação transforme lixo em "telefone válido" |
| 3 | `helpers/phoneHelper.js` — `normalizePhoneBRParaCadastro` | variante **só de escrita**: corrige também as formas que a regra BR strict aceita intactas e transformam em DDD inexistente (`0`+DDD com 11 díg., `55`+`0`+DDD com 13) |
| 4 | `helpers/phoneHelper.js` — `corrigirTroncoZeroBR` | devolve o número corrigido **só** onde o fluxo normal erraria; `''` no resto. Uso: `corrigirTroncoZeroBR(x) \|\| x` |
| 5 | `services/contactSyncService.js` — `parseAgendaContact` | importação da agenda passa a usar a variante de escrita: contato com `0` no DDD entra como BR, não como "internacional" |
| 6 | `controllers/clienteController.js` + `controllers/chat/contactController.js` | cadastro manual aplica `corrigirTroncoZeroBR` na entrada |
| 7 | `services/conversaAbrirClienteService.js` + `contactController.abrirConversaCliente` | telefone impossível agora é **400 + `codigo: TELEFONE_CONTATO_INVALIDO`** com motivo acionável, não 500 |
| 8 | `frontend/src/chats/chatList.jsx` e `configuracoes/sections/ClientesSection.jsx` | 4xx no "abrir conversa" agora vira aviso na tela (o interceptor global só fala em 5xx/403/429; antes o clique ficava mudo) |

### 7.1 Efeito no passivo já gravado

Contato com `55034998265514` **passa a abrir** na conversa certa: a leitura resolve o número
para `5534998265514` e encontra/cria a conversa correta. O registro em `clientes` continua com o
telefone velho (nada é reescrito pelo código) — a limpeza das duplicatas é decisão do Miguel, com
as seções C/E do SQL.

As formas que o sistema **não** tem como adivinhar (código de operadora `041…`, número
internacional real) continuam recusadas — agora com 400 e mensagem explicando, em vez do 500 mudo.

### 7.2 Evidência de não-regressão

- `tests/contatoTroncoZeroAbrirConversa.test.js` (novo, 11 casos): compara a implementação
  **anterior** com a atual em 6 mil entradas aleatórias de 1 a 20 dígitos — nenhum número que a
  versão antiga aceitava muda de resultado; nenhuma recuperação devolve DDD começando com 0.
- Varredura manual com 100 mil entradas, classificando **cada** diferença contra a implementação
  original: 4.144 são a mudança deliberada do doc 38 (11 dígitos internacionais deixam de ganhar
  `55`), 595 são a recuperação de tronco deste doc (entradas que antes eram recusadas) e
  **0 diferenças sem explicação**.
- Suíte backend completa: **3473 testes / 269 suítes, tudo verde**.
- Suíte Node do frontend: **58/58**.

### 7.3 Convivência com a correção do doc 38

As duas correções mexem na mesma função e foram verificadas **juntas**. O doc 38 alterou o ramo
de 10/11 dígitos (número internacional de 11 dígitos não leva mais o `55`); esse ramo sempre
retorna, então a recuperação de tronco deste doc, que fica depois dele, nem chega a vê-lo. O
tronco de 11 dígitos (`034…`) continua entrando no ramo antigo de propósito — é o caso descrito
no §8, corrigido na escrita.

---

## 8. O que ficou de fora de propósito

- **`55` + `0` + DDD com 13 dígitos na LEITURA** (`5503499826551`): a regra BR strict devolve
  intacto e o ramo novo nem chega a ver. Corrigir ali mudaria o resultado de um formato hoje
  aceito, e registros antigos gravados assim deixariam de casar com a própria conversa. A
  correção mora no caminho de escrita (item 3/5 acima), então **novos** contatos entram certos e
  os antigos ficam como estão até uma limpeza decidida.
- **Número internacional de verdade** (`+351…`): continua sem abrir conversa. Isto é proposital —
  ver doc 38: aceitar o número no envio sem endereço válido produz mensagem com ✓ que nunca chega.
  **Atualizado em 05/11, depois do doc 38 §6:** o caso de **11 dígitos** (`+33 780259005`,
  `+1 415…`) deixou de virar `55…` e passa a ser guardado e enviado como está — ali o endereço
  É válido, só não é brasileiro. O que segue recusado é o internacional de **12+ dígitos**
  (`351912345678`), que `normalizePhoneBR` devolve como `''`. O ramo de tronco `0` descrito
  neste documento não mudou: 11 dígitos começando com `0` continuam no caminho antigo.
- **Reescrever `clientes.telefone` do passivo**: nenhuma linha é alterada pelo código. Fica para o
  SQL, com conferência antes.
