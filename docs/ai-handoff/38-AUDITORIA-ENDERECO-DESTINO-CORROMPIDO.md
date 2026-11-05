# 38 — Auditoria: "mostra enviada mas não foi" — endereço de destino corrompido pelo `55`

> 2026-11-05 · auditoria **+ correção aplicada** (§6). **Nenhum dado escrito no banco.**
> Gatilho: empresa 24 (CCAA), conversa 42180 (Lucas Oliveira) — atendente via tique de "enviada"
> em mensagens que o cliente nunca recebeu.
> Evidência: `webhook_logs` de produção, tabelas `mensagens`/`conversas`/`clientes`/`whatsapp_instances`,
> e `GET /messages/{id}` na Whapi com o token do próprio canal da empresa (`HULKBR-Q2SMT`).
> SQL de varredura: [`scripts/diagnostico_endereco_destino_corrompido.sql`](../../scripts/diagnostico_endereco_destino_corrompido.sql)
> Parente direto: [39 — contato que não abre conversa](39-AUDITORIA-CONTATO-NAO-ABRE-CONVERSA.md).
> Este é o lado **aceita e corrompe**; o 39 é o lado **rejeita e explode**. Mesmo helper.

---

## 1. Resumo em uma frase

`normalizePhoneBR` prefixa `55` em **qualquer** número de 10 ou 11 dígitos. Um celular francês
(`+33 780259005`, 11 dígitos) virou `5533780259005`; todo envio do ZapERP foi para esse endereço
inexistente, a Whapi aceitou e devolveu um id, e a mensagem ficou `pending` para sempre — mas a
bolha desenha ✓ ("enviada") porque existe `whatsapp_id`.

---

## 2. O caso, lado a lado

Contato: **Lucas Oliveira**, cliente `1145258`, conversa `42180`, empresa 24, instância 24
(provider `whapi`, canal `HULKBR-Q2SMT`, número conectado `553499951976`).

| Quem enviou | `chat_id` usado | `source` | status final |
|---|---|---|---|
| O cliente (3 mensagens, 04/11 16:17–16:18) | `33780259005@s.whatsapp.net` | `mobile` | recebidas |
| A atendente pelo **celular** (05/11 09:11 e 09:12) | `33780259005@s.whatsapp.net` | `mobile` | **`delivered` em 3 s** |
| O **ZapERP** (9 mensagens, 04/11 16:18 → 05/11 09:12) | `5533780259005@s.whatsapp.net` | `api` | **`pending`, sem exceção** |

`+33 7 80 25 90 05` é um celular **da França**. `33780259005` tem 11 dígitos — exatamente o formato
de um celular BR `DDD + 9 + 8`. O helper não distingue os dois e cola o `55`.

### 2.1 Evidência no `webhook_logs` (empresa 24, 04/11 19:17–19:26 UTC)

```
19:17:26  MSG rJLOjiEumrycgun...  chat_id=33780259005@s.whatsapp.net    from_me=false source=mobile
19:17:26  CHAT id=33780259005@s.whatsapp.net      name="Lucas Oliveira"
19:18:37  MSG Pspz0AsEzwFPNsA-wJkFCG8BsL0  chat_id=5533780259005@s.whatsapp.net  from_me=true source=api status=pending
19:18:38  CHAT id=5533780259005@s.whatsapp.net    name=null          ← chat fantasma
```

O aparelho conectado passou a ter **dois** chats: o real (`33780259005`, com nome) e um fantasma
(`5533780259005`, sem nome) criado pelos envios da API.

### 2.2 Evidência direta no provedor (`GET /messages/{id}`)

```
Psq7aFCa.u48BgM-wA8FCG8BsL0   status=pending    chat_id=5533780259005@…   document  (PDF, 05/11 09:12)
Pspz0AsEzwFPNsA-wJkFCG8BsL0   status=pending    chat_id=5533780259005@…   text      (04/11 16:18, +18 h)
paNJQJqBKu9VgVGv5arEjQ-…      status=delivered  chat_id=33780259005@…     text      (enviada do celular)
```

Na Whapi, `pending` (code 1) significa **aceita pela API e nunca transmitida**. Não é demora de
ACK: é ausência de envio. As 9 mensagens (3 textos, 1 PDF, 1 vídeo, 2 imagens, 1 texto e o PDF
reenviado hoje) não chegaram e não vão chegar.

### 2.3 A prova final — o MESMO PDF, dois endereços, no mesmo dia

Em 05/11 a atendente reenviou do **celular** o arquivo que o ZapERP não tinha entregue:

| mensagem | id | endereço | status |
|---|---|---|---|
| `Portfólio Preteen Course.pdf` via ZapERP, 09:12 | `Psq7aFCa.u48BgM-wA8FCG8BsL0` | `5533780259005` | **`pending`** |
| áudio pelo celular, 11:09 | `pV904uWRM0Zo0yjDG.OHaA-x…twAAwEo` | `33780259005` | `played` |
| **o mesmo PDF** pelo celular, 11:15 | `pScvSNe0Nw9gbsQZAwgzAQ-x…twAAwEo` | `33780259005` | **`delivered`** |

E às 11:10 o cliente respondeu `Ok obrigado`. Mesmo arquivo, mesma conta, mesma hora:
muda só o endereço e muda o desfecho. Não sobra hipótese de bloqueio, tamanho de arquivo,
tipo de mídia ou limite da conta.

### 2.4 Caso de controle — ★Thicy★ (conversa 37889, mesma empresa, mesmo dia)

Também aparecia com um tique só, mas **não é o mesmo defeito**:
`conversas.telefone = 553484217473` bate com `clientes.wa_id = 553484217473@s.whatsapp.net`,
e o `GET /messages/{id}` devolve **`sent`** — saiu do WhatsApp, aguarda o aparelho do destinatário.
Um tique com destinatário offline é comportamento normal do WhatsApp.

**Regra de leitura para o futuro:** `pending` no provedor = nunca saiu. `sent` = saiu, falta o
aparelho. A UI hoje desenha o mesmo ✓ para os dois (§4).

### 2.5 Varredura completa da empresa 24 (04/11 10:33 → 05/11 14:12)

A consulta 4 rodada sobre todo o `webhook_logs` da empresa no período devolveu **148 pares
endereço × origem**, cobrindo ~90 conversas. **Uma única conversa diverge: a 42180.** Todas as
outras usam no envio exatamente o endereço que o contato usa. Isto descarta "problema do canal",
"problema do PDF" e "problema de hoje": o defeito é do endereço daquele contato.

Dois achados secundários saíram dessa varredura, e nenhum é defeito — estão aqui porque a
consulta os levanta e a próxima pessoa vai tropeçar neles:

1. **Diferença de nono dígito entre `clientes.telefone` e o endereço real é inofensiva.**
   Ex.: `Débora Mãe Clara Leão` tem `telefone = 5534997132883` e
   `wa_id = 553497132883@c.us`; o envio pela API em 04/11 21:09 saiu para `553497132883` e
   funcionou. O resolvedor da Whapi (`whapiRecipientResolverService` + `recipientAttemptList`)
   acerta o destino nesse caso. **Só o `55` colado é fatal**, porque muda o país, não a forma.
2. **"Endereço sem conversa" = conversa apagada, não mensagem perdida.** Na janela apareceram
   `553497132883` e `553488217930` com tráfego real nos dois sentidos e nenhuma conversa no
   banco. O cliente continua lá e o `ultimo_contato` dele bate no segundo com o último webhook
   (21:09:46 e 22:07:06), prova de que o inbound rodou. O que sumiu depois foi a conversa:
   `services/chat/deletion/conversationDeletionService.js:83` dá `DELETE` em `conversas`, e o
   cleanup dá `DELETE` em `mensagens` — ação de atendente, sem registro em `auditoria_log`
   (que está vazio para a empresa 24).

### 2.6 Dois erros da primeira versão da consulta 4 (corrigidos em 05/11)

Registrados porque o CSV os expôs e quem reler os resultados antigos precisa saber:

- **O endereço fantasma vinha carimbado `ok`.** A consulta comparava `endereco_real` com
  `conversas.telefone`; para a linha `5533780259005 / from_me=true / api` os dois são iguais —
  porque o telefone armazenado **é** o endereço errado. A comparação certa é
  "endereço que o contato usa (`from_me=false`)" × "endereço que a API usa
  (`from_me=true AND source='api'`)", e é assim que a consulta funciona agora: conta endereços
  distintos por conversa e separa as colunas por origem.
- **O balde "sem conversa com este endereço" era falso alarme por `JOIN` incompleto.** Ele só
  tentava `endereco` e `'55' || endereco`, nunca as formas com/sem o nono dígito — então toda
  conversa guardada na outra forma aparecia como inexistente. A consulta 4b agora expande as
  quatro formas e ainda cruza com `clientes.ultimo_contato` para distinguir conversa apagada
  de perda real.

Valores de `source` observados no provedor, para quem for ler o payload: `mobile` (aparelho),
`web` (WhatsApp Web), `api` (ZapERP) e `system` (eventos de sistema — criptografia, ações).

---

## 3. Causa raiz

`helpers/phoneHelper.js:32` — `normalizePhoneBR`:

```js
if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) return digits
if (digits.length === 10 || digits.length === 11) return '55' + digits   // ← aqui
return ''
```

Entra pelo inbound em `controllers/webhookInbound/payload.js:212` (`normCandidate` →
`looksLikeBRPhoneDigits`, que aprova qualquer coisa com 10 ou 11 dígitos) e em
`helpers/conversationKeyHelper.js:49`. `helpers/conversationSync.js:68` (`getCanonicalPhone`)
assume o mesmo contrato — e o comentário do arquivo é explícito: *"Só aceitamos telefone BR válido"*.

Consequências do desenho atual para número estrangeiro:

| dígitos totais | exemplo | o que acontece |
|---|---|---|
| 10 ou 11 | `+33` + 9, `+1` + 10, `+34` + 9, `+56` + 8 | **`55` colado na frente** → endereço inexistente, falha silenciosa |
| 12 ou mais (sem `55`) | `+351` + 9, `+44` + 10, `+49` + 10 | `normalizePhoneBR` devolve `''` → contato **descartado** |

Agravantes neste caso:

1. `clientes.wa_id` ficou `null` (só é preenchido pela sincronização de contatos), então não havia
   o JID verdadeiro como alternativa de envio.
2. A Whapi **aceitou** o POST (`sent: true` + `message.id`). O `recipientAttemptList`
   (`services/providers/whapi/send.js:60`) só tenta uma segunda forma do número quando o provedor
   **recusa o destino** (`isInvalidRecipientSend`) — aqui ele não recusou.
3. O inbound continua casando (o `33780259005` que chega é normalizado para `5533780259005` e
   encontra a conversa), então a conversa parece saudável: entra mensagem, sai "mensagem enviada".

---

## 4. Por que o atendente vê ✓ e não um relógio

`frontend/src/utils/messageTicks.js:157`:

```js
const confirmadoPeloProvedor = temIdDoProvedor(msg) && !isErr && !isAguardandoConexao;
const isPending = !isRetry && !confirmadoPeloProvedor && (… s === "pending" …);
```

Basta existir `whatsapp_id` para `isPending` virar falso — **mesmo com `status: 'pending'`**.
Foi decisão deliberada de 13/10/2026, comentada no próprio arquivo: antes desenhava relógio,
o atendente lia "não enviei", reenviava e **duplicava no cliente**.

O efeito colateral é este laudo: o mesmo ✓ hoje representa dois estados opostos — "o WhatsApp
transmitiu, falta o aparelho" e "o WhatsApp nunca transmitiu". Ver também doc
[33](33-AUDITORIA-SETAS-STATUS-WHAPI.md) §2 item 14 (decisão de nunca mascarar `erro`).

### 4.1 E nada escala

`services/pendingOutboundReconciliationService.js:276-281`:

```js
if (providerRowIndicatesPending(providerRow)) {
  const currentStatus = String(row.status_mensagem || row.status || '').toLowerCase()
  if (currentStatus === 'sent') {
    return patchMessage(row, { status: 'pending', status_mensagem: 'sending' }, io)
  }
  return { ok: true, action: 'keep_provider_pending' }   // ← para sempre
}
```

A varredura **consulta** o provedor a cada 5 min, **recebe `pending`** e devolve
`keep_provider_pending` indefinidamente: sem alerta, sem `erro`, sem diferença visual. A regra
antiga que virava `erro` por decurso de prazo (`PENDING_OUTBOUND_WHAPI_UNACKED_FAIL_MINUTES`) foi
restringida em 15/10 justamente porque gerava alarme falso em mensagem entregue — hoje ela só
alcança linhas que já estão em `erro` com id.

---

## 5. Alcance medido (produção, 05/11/2026)

**Empresa 24 desde 01/11** — o canal está saudável: 587 mensagens de saída, 273 `delivered`,
262 `read`, 28 `played`, 0 `erro`. As **9** presas em `pending` são **todas** da conversa 42180.
Hoje (05/11): 25 entregues + 15 lidas — ACK fluindo normalmente.

**Todas as empresas desde 01/10** — `direcao='out' AND status='pending' AND whatsapp_id IS NOT NULL`:
**61 mensagens em 30 conversas de 7 empresas** (1, 4, 6, 14, 15, 24, 25). Todas aparecem como
"enviada" para o atendente e nenhuma saiu do WhatsApp.

Dessas 30 conversas, **só a 42180 tem o endereço corrompido**. As outras 29 têm número de forma
válida e caem no mesmo buraco por outro motivo — na amostra, predominam **fixos** sem WhatsApp
(`553433212339`, `553433213334`, `553434311688`, `551137093000` “Fator Seguradora”) e celulares sem
conta. O WhatsApp aceita o envio e nunca transmite.

**Contatos com a assinatura da corrupção** (`conversas.telefone ~ '^55[0-9]{11}$'` com o 5º dígito
≠ `9`, isto é, 13 dígitos que não podem ser celular BR): **74 conversas** em todo o banco
(32.411 analisadas). Amostra do que há lá dentro, já decodificado:

| conversa | armazenado | leitura provável |
|---|---|---|
| 42180 (emp 24) | `5533780259005` | `+33 780259005` — França |
| 12826 (emp 9) | `5514752552920` | `+1 475 255 2920` — EUA |
| 10697 (emp 20) | `5519293259135` | `+1 929 325 9135` — EUA |
| 38238 (emp 25) | `5559816121859` | fora de qualquer padrão BR |

O detector de 12 dígitos (`55` + 10) **não serve**: devolve 26.298 linhas, porque é a forma legítima
do celular BR guardado sem o 9. Números estrangeiros que caem nessa faixa não são separáveis por
forma — só pelo `chat_id` real no `webhook_logs`.

---

## 6. A correção aplicada (05/11, **não deployada**)

Princípio, o mesmo do doc 39: **nada que hoje funciona pode mudar de resultado.** A regra nova
só decide o que fazer com 11 dígitos — e no Brasil 11 dígitos é sempre `DDD + 9 + 8`.

### 6.1 A prova que autoriza a mudança

Um JID individual do WhatsApp é sempre o endereço internacional completo. Para o Brasil isso dá
12 (`55+DDD+8`) ou 13 (`55+DDD+9+8`) dígitos — **nunca 10 nem 11**. Medido, não suposto:

| Fonte | Amostra | JID com 10–11 dígitos |
|---|---|---|
| `clientes.wa_id`, todas as empresas | 23.736 linhas | **0** (mínimo observado: 12) |
| `chat_id` no tráfego vivo do `webhook_logs` | 1.449 eventos | 13 — **todos** o `33780259005` deste laudo |

Ou seja: o ramo "10 ou 11 dígitos ganha `55`" nunca acerta um JID brasileiro. Ele só acerta
número digitado por humano (cadastro, importação, busca) — e esse caminho fica intacto.

### 6.2 O que mudou

| # | Arquivo | O que mudou |
|---|---|---|
| 1 | `helpers/phoneHelper.js` — `podeSerCelularBrSemDdi` | novo: 11 dígitos só podem ser BR com **DDD existente** (lista Anatel) **e** nono dígito `9` |
| 2 | `helpers/phoneHelper.js` — `normalizePhoneBR` | o ramo de 11 dígitos foi partido: ganha `55` só o que pode ser celular BR; o resto sai **intacto**, por já ser endereço internacional. 10 dígitos e tronco `0` seguem idênticos |
| 3 | `helpers/phoneHelper.js` — `toZapiSendFormat` | mesma regra, para o caminho de envio da UltraMSG |
| 4 | `helpers/phoneHelper.js` — `formaLegadaCom55` | novo: devolve a forma antiga (`'55' + X`) **só para busca** |
| 5 | `helpers/phoneHelper.js` — `possiblePhonesBR` e `possiblePhonesForWhatsappIdentity` | passam a incluir a forma legada, para o registro gravado antes do fix continuar sendo encontrado |

O envio não precisou de mudança: `preferredBrSendDigits` já devolve `''` para o que não é BR e
`recipientCandidates` (Whapi) já cai nos dígitos crus — com a regra nova isso passa a ser o
endereço certo. Conferido nos dois providers:

```
33780259005  → whapi recipientCandidates ["33780259005"]  chatId 33780259005@s.whatsapp.net
33780259005  → ultramsg toUltramsgPhone  +33780259005
34999999999  → whapi recipientCandidates ["5534999999999"]   (BR, inalterado)
553484217473 → whapi recipientCandidates ["5534984217473"]   (BR, inalterado)
```

### 6.3 Por que não duplica conversa

Esse era o risco real: a conversa 42180 está gravada como `5533780259005`, e a chave nova é
`33780259005`. Sem rede, o próximo inbound abriria uma segunda conversa e o histórico pareceria
ter sumido. Por isso o item 5: a busca (`.in('telefone', variants)`) passa a procurar as **duas**
formas, então o registro antigo continua sendo achado.

Não há risco de casar com outra pessoa: `'55' + X` só é um número brasileiro de verdade quando
`X` é celular BR — e esse caso nem chega à forma legada. Está travado em teste.

### 6.4 Evidência de não-regressão

- `tests/enderecoInternacionalSemDdi55.test.js` (novo, 19 casos): diferencial velho × novo sobre
  8.000 entradas aleatórias de 1 a 20 dígitos — **nenhuma** entrada muda de resultado fora da
  classe "11 dígitos que não podem ser BR", e **nenhuma** entrada antes aceita passa a ser
  recusada. Mais 450 celulares BR gerados em 9 DDDs, todos continuam ganhando o `55`.
- `tests/contatoTroncoZeroAbrirConversa.test.js` (doc 39) continua passando; a exceção da classe
  nova está explícita no filtro, não escondida.
- Suíte backend completa: **3473 testes / 269 suítes, tudo verde** (`npx jest --no-cache`).

### 6.5 O que o deploy NÃO resolve

As 75 conversas já gravadas continuam com o `55` indevido em `conversas.telefone`, e o envio
continua saindo para lá. Isso é **dado**, não código: bloco 5 do SQL, depois do deploy, um
contato por vez. Sem colisão de unicidade no caso 42180 (nem cliente nem conversa com
`33780259005` na empresa 24; a unicidade é composta `(company_id, telefone)` desde
`scripts/aplicar_clientes_telefone_unique_por_empresa.sql`).

### 6.6 Deixado de fora de propósito

1. **Persistir o JID de origem** em `clientes.wa_id`/`conversas.chat_lid` e dar prioridade a ele
   no envio. Seria cinto e suspensório, mas mexe no caminho quente do envio sem que haja caso
   medido que a regra nova não cubra.
2. **Reescrever o passivo pelo código.** Nenhuma linha é alterada automaticamente — a adoção da
   conversa antiga é só de leitura. Rebatizar o telefone sozinho, num caminho de webhook, é o
   tipo de escrita que não dá para desfazer.
3. **Separar `pending` de `sent` na UI.** Continua pendente e continua sendo o buraco que tornou
   isto invisível por 18 h (§4). Não voltar ao relógio — duplicaria reenvios; o que falta é um
   estado próprio para "o provedor diz que ainda não transmitiu há N horas".
4. **Alerta operacional** para `pending` com id do provedor acima de ~2 h por empresa. Hoje
   `keep_provider_pending` é silencioso e nada no produto denuncia 61 mensagens não entregues.
5. **Número estrangeiro de 12+ dígitos** (`+351…`, `+971…`): `normalizePhoneBR` devolve `''` e o
   contato é descartado no `getCanonicalPhone`. É o outro lado do doc 39 §8 e continua aberto —
   mas aí o sintoma é honesto (não abre), não a mentira do ✓.

---

## 7. Como reproduzir / varrer

`scripts/diagnostico_endereco_destino_corrompido.sql` — consultas 1 a 4 são **somente leitura**;
a 5 é o reparo pontual, comentado e condicionado ao item 6.1-1.

Registro rápido do que cada uma responde:

| # | pergunta |
|---|---|
| 1 | quais mensagens aparecem como "enviada" e o provedor nunca transmitiu (`pending` + `whatsapp_id`) |
| 2 | quais conversas têm a assinatura do `55` indevido (13 dígitos, 5º ≠ 9) |
| 3 | cruzamento das duas anteriores — prioridade de reparo |
| 4 | forense por conversa: endereço que o contato usa × endereço que a API usa |
| 4b | endereços com tráfego e sem conversa — separa conversa apagada de perda real |
| 5 | reparo pontual (**só depois do DEPLOY do fix** — §6.5) |

As consultas 4 e 4b expandem `jsonb` sobre `webhook_logs` (~519 mil linhas): sempre com
`company_id` e janela curta, nunca sem filtro.
