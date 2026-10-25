# Doc 29 §3 itens 15 e 14 — LGPD nos logs e mapas sem TTL

Dois itens do backlog do doc 29, implementados em 2026-10-25. Ambos só código, nenhuma
migration, nenhuma mudança de contrato com o frontend. **Não deployado.**

## Item 15 — telefone completo e texto da mensagem nos logs

### O que havia

`controllers/webhookZapiController.js`, em **toda** mensagem recebida:

```js
console.log('📩 Z-API [GRUPO]', phone, nomeGrupo || '', fromMe ? '(de mim)' : `(${senderName || participantPhone || 'participante'})`, texto?.slice(0, 50))
console.log('📩 ULTRAMSG mensagem recebida:', phone, fromMe ? '(enviada por nós)' : '(recebida)', texto?.slice(0, 50))
```

Telefone **completo** do cliente, nome do contato e os primeiros 50 caracteres do **texto
da mensagem** — isto é, conteúdo de conversa de cliente — replicados no log, onde ficam
fora de qualquer controle de acesso do produto e sem retenção definida. Havia o mesmo
problema, em menor escala, no log de newsletter (`:855`).

O argumento decisivo: **o texto já está na tabela `mensagens`**. Logá-lo outra vez não
acrescenta informação de diagnóstico, só exposição.

### A correção

Novo `helpers/redactLogPII.js`, com três funções e uma regra: nunca o valor, sempre a forma.

| Função | Entrada | Saída |
|---|---|---|
| `telefoneParaLog` | `'5511987654321'` | `'****4321'` |
| `textoParaLog` | `'bom dia'` | `'txt:7'` (ausente → `'txt:-'`) |
| `nomeParaLog` | `'Claudia DB'` | `'C.(10)'` |

Isto não inventa convenção nova: `services/disparoSendService.js` já logava
`'tel=****', phoneLast4(telefone)`. O helper põe o padrão num só lugar, para o caminho
quente. `disparoSendService` ficou como está — já estava correto, e mudá-lo só pelo
cosmético seria risco sem ganho.

`textoParaLog` distingue `'txt:0'` (veio vazio) de `'txt:-'` (não veio campo), que é a
diferença que de facto interessa ao diagnosticar.

### Verificação

`tests/redactLogPII.test.js` — **13 testes**. Além das funções, trava a **política** no
caminho quente: um `console.log` que volte a passar `phone`/`texto` crus nas duas linhas de
inbound reprova. A verificação não tenta equilibrar parênteses (foi o que quebrou a
primeira versão do teste); procura cada ocorrência de `phone`/`texto` na janela de
argumentos e exige que venha imediatamente depois de um redator.

**5 mutações, todas detectadas:** cada função a devolver o valor cru, e as duas linhas de
inbound revertidas ao telefone cru e ao recorte do texto.

### Nota sobre o import

A primeira tentativa inseriu o comentário e **não** o `require`: o guard "o arquivo já
menciona `redactLogPII`" casou com o próprio comentário que eu tinha acabado de escrever.
`node --check` passou, porque só faz parse — não resolve identificadores. É a mesma
armadilha do doc 13 (ReferenceError órfão da modularização). Há agora um teste que exige o
`require` explicitamente, e a conferência passou a ser "todos os identificadores usados
estão importados?", não "o arquivo menciona o helper".

## Item 14 — mapas de debounce do chatbot sem TTL

### O que havia

`services/chatbotTriageService.js` mantém quatro mapas de debounce por conversa:
`lastWelcomeSentAt`, `lastOpcaoInvalidaSentAt`, `lastForaHorarioSentAt` e
`lastMenuEnviadoServerAt`. Eram limpos **só** no fim do fluxo de triagem; conversa que
nunca chega lá deixava a entrada para sempre — leak lento, estimado no doc 29 em
0,3–1 MB/dia.

### A correção

Varredura periódica (60 s, com `unref()`) removendo entradas com mais de **10 minutos**,
no mesmo padrão do `conversationVisibilityService` (doc 29 item 9).

Por que 10 minutos é seguro, e não um palpite: a **maior** janela de leitura é
`OPCAO_INVALIDA_DEBOUNCE_MS` = 60 s; as outras são 15 s, 10 s e 8 s. Nenhuma vem de
configuração (conferido: as quatro são constantes no módulo). E os quatro sítios de leitura
usam `|| 0` — "nunca enviado" — que é exatamente a conclusão a que a janela expirada já
chegaria. Logo, podar com 10 min (10× a maior janela) não muda decisão nenhuma do bot.

`lastChatbotSendPerCompany` ficou **de fora de propósito**: a chave é o `company_id`, então
é limitado pelo número de empresas e não cresce com o tempo.

### Verificação

`tests/chatbotDebounceMapsPrune.test.js` — **8 testes**, incluindo os que protegem o bug
original: entrada dentro da retenção **fica** (podar cedo reintroduziria menu duplicado em
rajada, que é o motivo de estes mapas existirem), o limite da retenção é inclusivo, e a
retenção tem de continuar muito maior que a janela de debounce.

**6 mutações, todas detectadas:** poda tudo, deixa de limpar valor não-numérico, retenção
reduzida a 30 s, esquece um dos mapas na lista, limite da retenção passa a exclusivo — e
`remove o unref`, que merece nota.

A mutação do `unref` **trava o jest para sempre**: sem ela, o `setInterval` mantém o
processo de Node vivo e o runner nunca termina. Descobri isso da pior maneira — a primeira
execução das mutações ficou pendurada nessa e deixou o arquivo em estado mutado, que tive
de restaurar à mão (as mudanças não estavam commitadas, então `git checkout` as
destruiria). Vale registar porque é evidência melhor do que a asserção de texto que o teste
faz: remover o `unref` não é cosmético, impede a suíte de terminar. A asserção continua a
ser sobre a fonte porque a alternativa — deixar a suíte travar para provar o ponto — não é
um teste utilizável.

## O que NÃO foi feito, e por quê

**Item 4 da auditoria de produção (keep-alive do cliente Supabase).** A lacuna é real —
não há agent HTTP configurado em lugar nenhum, e o `keepAliveTimeout` padrão do undici é
4 s, contra tráfego em rajada. Mas:

- a **magnitude não está provada**: medir de fora falhou porque o jitter até Boston
  (±30 ms) é maior que o efeito;
- a correção de menor risco é **env, não código**: apontar `SUPABASE_URL` para o hostname
  interno do Docker (hoje é `http://supabasekong-....sslip.io/`, saindo pelo IP público);
- a correção em código passaria o cliente Supabase de `undici` para `node-fetch@2` (que
  já está instalado) para poder passar um `http.Agent`. Isso troca a implementação de
  `fetch` de **todas** as queries do sistema — `node-fetch@2` devolve stream de Node onde
  o undici devolve `ReadableStream` web. É risco no caminho mais quente que existe, em
  troca de um ganho não medido.

Ordem certa: medir dentro da VPS primeiro. O comando está em
`frontend/docs/audits/auditoria-producao-2026-10-24.md`.

**Itens 1, 2, 3, 6 do doc 29 §3** continuam abertos: todos mudam regra de negócio ou
contrato com o frontend (tempestade de refetch, regressão de status, guarda do
`encerrarChat`, round-trips do inbound). Precisam de decisão sua, não só de código.

---

# Sessao de 25/10 (parte 2) — o resto dos itens 14 e 15

Na primeira passagem eu dei os itens 14 e 15 por fechados. Estavam **parciais**. Isto
fecha o resto, e corrige dois pontos do proprio doc 29.

## Item 14 — o outro par de mapas

Faltavam `_lastSyncByConv` e `_lastFotoRefreshByConv`, em
`services/ultramsgSyncContact.js`. Chave `company_id:conversa_id`, nada apagava.

**A armadilha, que e o ponto todo deste item:** os dois mapas protegem janelas muito
diferentes — 60 s para o sync, **6 horas** para a reconsulta de foto no provedor. Uma
retencao unica (a menor, como fiz no chatbot) apagaria a marca da foto antes das 6 h e o
servico voltaria a bater no provedor em rajada, que e exatamente o que o
`FOTO_REFRESH_TTL_MS` existe para evitar. Por isso:

| mapa | janela que protege | retencao |
|---|---|---|
| `_lastSyncByConv` | 60 s (`SYNC_DEBOUNCE_MS`) | 10 min |
| `_lastFotoRefreshByConv` | 6 h (`FOTO_REFRESH_TTL_MS`) | 7 h |

Novo `helpers/pruneMapaPorIdade.js` com a logica generica e a regra escrita no topo
("a retencao tem de ser confortavelmente maior que a janela que o mapa protege"), mais
`agendarVarredura`, que aplica o `unref()` — o esquecimento dele foi o que travou o jest
na passagem anterior.

`tests/pruneMapasSync.test.js`, **10 testes**, incluindo um que falha se alguem unificar as
duas retencoes e outro que verifica que a marca da foto sobrevive a 5 h e some depois das
6 h + folga.

## Item 15 — o que faltava, e um sitio pior do que o item dizia

Em `helpers/conversationSync.js` havia **quatro** sitios com telefone cru, e dois deles
**nao eram caminho de erro**:

| linha | o que logava | quando corria |
|---|---|---|
| ~73 | `phoneStr` (telefone invalido) | erro |
| ~970 | `telefoneCanonico` (insert falhou) | erro |
| ~1056 | `"${phone}"` (nao normalizou) | erro |
| ~1077 | `canonical` **e todas as variantes** | **toda mensagem, sucesso** |
| ~1115 | `conv.telefone` | **toda mensagem, sucesso** |
| ~1203 | `canonical` (conversa criada) | criacao |

Ou seja: o telefone completo ia para o log **duas vezes por mensagem**, e um dos logs
enumerava todas as variantes do numero (o doc 29 falava de "telefone completo logado", mas
nao que fosse duas vezes e com as variantes).

Todos passam agora por `telefoneParaLog`. Nos dois de caminho de erro onde o diagnostico e
a **forma** do numero e nao o numero, acrescentei a contagem de digitos — que e o que de
facto se quer saber quando a normalizacao falha. Os dois de caminho quente (~1077 e ~1115)
ficaram atras de `WHATSAPP_DEBUG`, seguindo a convencao que ja existe em
`controllers/webhookInbound/log.js`: sao detalhe de diagnostico da familia de bugs do 9o
digito, nao informacao de operacao. Isto tambem corta 2 linhas de log por mensagem, que era
a segunda metade do item 15 ("~7-15 linhas por mensagem").

`tests/redactLogPII.test.js` cresceu para **17 testes**, com uma varredura que percorre
TODAS as 21 chamadas de console do arquivo e reprova qualquer log novo que volte a levar
telefone cru — nao apenas as seis linhas corrigidas.

**7 mutacoes, todas detectadas** (incluindo "volta a logar o telefone cru", que prova que a
varredura nao passa por acidente, e "remove o unref", detectada por travar o jest).

### Nota sobre o teste que escrevi errado duas vezes

A varredura de politica passou nas duas primeiras versoes **por motivo errado**: as regex
estavam quebradas. Na primeira, tentei casar `/\D/g` literalmente — num literal de regex
`\D` e a classe "nao-digito", nao o texto. Na segunda, um `` escrito num heredoc virou
um **caractere de backspace (0x08) dentro do arquivo de teste**, anulando a terceira
substituicao em silencio. Só a mutacao revelou isso. Fica como aviso: teste de politica que
depende de regex sobre codigo-fonte **tem** de ser validado por mutacao, senao e decorativo.

## Correcoes ao doc 29 §3

**Item 11 (`/media/proxy` baixa o arquivo inteiro a cada Range) — JA CORRIGIDO, item
desatualizado.** `controllers/mediaProxyController.js` tem cache LRU persistente
(`_bodyCache`, TTL 10 min, teto 64 MB total / 12 MB por item) **e** dedupe de voo
(`_inflight`), logo Range serve da memoria. Foi resolvido nas auditorias de audio. **Nao
refazer.** Residual real, bem menor: arquivo acima de 12 MB nao entra no cache, logo um
video grande ainda re-baixa a cada Range — mas isso e ajustavel por
`MEDIA_PROXY_CACHE_MAX_ITEM_BYTES` e troca RAM da VPS por banda, o que e decisao, nao bug.

**Item 9 (contadores erram acima de 2000)** — o teto e `CHAT_FILTER_ID_LIMIT` em
`services/chat/read/searchLimits.js`, **ja ajustavel por env** (default 2000, teto 5000).
Subir a env e paliativo e custa varredura. O fix real continua a ser denormalizar
"tem mensagem?" em `conversas`, o que exige **migration** — decisao do Miguel, nao
"melhoria segura".
