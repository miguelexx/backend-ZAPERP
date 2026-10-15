# 31 — Reparo retroativo da mídia recebida sem `link` do provedor

> Criado em **2026-10-15**, depois da auditoria que corrigiu o caminho ao vivo.
> As correções de código valem só para o que chega **daqui pra frente**. Este doc trata do
> **passivo**: o que já está quebrado no banco, o que dá para recuperar e como.
> Nada aqui foi executado. Nenhuma migration é necessária.

Entregáveis desta frente:

| Arquivo | O que é |
|---|---|
| `supabase/scripts_manuais/diagnostico/MIDIA_SEM_LINK_PASSIVO.sql` | 10 consultas **somente leitura** para medir o estrago (Supabase SQL Editor) |
| `scripts/reparar-midia-sem-link.js` | Gatilho do reparo em massa, **dry-run por padrão**, `--company-id` obrigatório |
| `tests/reparoMidiaSemLinkScript.test.js` | 20 testes dos puros do script (seleção, args, fuso, forma das queries) |

---

## 1. As três formas do passivo

A causa de origem é a setting `media.auto_download` do canal Whapi: ela só entrega o campo `link`
no webhook para os tipos incluídos nela. Sem `link`, cada tipo degradava de um jeito diferente:

| Caso | O que ficou no banco | Reparável? |
|---|---|---|
| **A** — foto/vídeo/documento **sem legenda** (`!fromMe`) | **Nada.** `soPlaceholderMidia` (`controllers/webhookZapiController.js:1915`) atualizava só `conversas.ultima_atividade` e seguia (`continue`) | Sim, por import de histórico (§3) |
| **B** — foto/vídeo/documento **com legenda** | Linha com `tipo='texto'`, `url` NULL, legenda no `texto` — nenhum rastro de que era mídia | Sim (§2) |
| **C** — áudio / figurinha | Linha com `tipo='audio'`/`'voice'`, `url` NULL, texto `(áudio)` | Sim (§2) |

Depois do deploy das correções, **A** passa a nascer como linha com texto tipado (`(imagem)`,
`(vídeo)`, `(arquivo)`) e `url` NULL — reparável pelo backfill automático em segundos.
Observação registrada: `applyInboundMediaFields` (`controllers/webhookInbound/persistMensagem.js:254`)
continua **não** marcando `tipo` para imagem/vídeo/documento sem URL (só áudio faz isso) — por isso
essas linhas ficam com `tipo='texto'` e o diagnóstico precisa procurar **também pelo texto**, não só
pelo tipo. Não foi alterado: o frontend classifica pelo texto placeholder e mudar o `tipo` padrão
mexeria em bolha, preview da lista e contadores.

---

## 2. O que é recuperável — linhas que existem (casos B e C)

`services/oldMessagesSyncService.js` busca o histórico do chat no provedor, casa a linha por
**`whatsapp_id`** e aplica `buildPlaceholderRepairPatch` (linha 410), que **só promove**:

- placeholder → texto real (texto real nunca é rebaixado);
- `(mensagem)` genérico → placeholder tipado;
- linha **sem URL utilizável** → URL do provedor + `tipo` + `nome_arquivo`;
- `contact_meta` / `location_meta` ausentes.

URL já utilizável (`https://`, `http://`, `/uploads/`, `/media/r2/`) **nunca** é sobrescrita, e
quando a linha ganha URL remota o serviço agenda a cópia para `/uploads`
(`insertPreparedMessagesForConversation`, linha 598) — é essa cópia que emite `nova_mensagem` e faz
a bolha virar player sem F5.

**Não é recuperável, mesmo com o reparo:**

- **Fora da janela de 45 dias** em canal Whapi (`CONTACT_HISTORY_WINDOW_DAYS`): o provedor não
  devolve. Perda definitiva.
- **Linha sem `whatsapp_id`**: o reparo casa por `whatsapp_id`; sem ele não há como ligar a linha do
  banco à do histórico. ⚠️ Pior: se o histórico trouxer essa mensagem, ela é **inserida como linha
  nova** (a dedup é por `whatsapp_id`, e o índice único `(conversa_id, whatsapp_id)` não barra NULL)
  → **bolha duplicada**. Meça antes: coluna `sem_whatsapp_id` nas consultas 2/3/10 do SQL. Em
  inbound normal isso é raro (o provedor manda id), mas confira antes do lote.
- **Conversa só com LID interno** (sem telefone/JID): não há `chatId` para pedir o histórico. O
  script conta essas conversas como "puladas (sem telefone)".
- **Mídia que o canal não guardou** (anterior à conexão do canal, ou já expirada na Whapi).

---

## 3. O caso A (foto/vídeo/documento descartados) — identificar × recuperar

### Identificar: só há pista, não prova

1. **`mensagens`** — não existe linha. Nada a consultar.
2. **`conversas.ultima_atividade`** — o descarte atualizava esse campo e não inseria nada. Então uma
   conversa cuja `ultima_atividade` é bem mais nova que a última mensagem gravada denuncia um evento
   perdido (consultas **8** e **8b** do SQL). É **pista, não prova**: ACK de mensagem antiga, reação,
   edição, enquete, mensagem apagada depois e import de histórico já rodado também movem a atividade.
   Atenção ao fuso: `mensagens.criado_em` é `timestamp without time zone` gravado em UTC e
   `conversas.ultima_atividade` é `timestamptz` — sem `AT TIME ZONE 'UTC'` a comparação erra 3h e
   **toda** conversa parece ter lacuna.
3. **`webhook_logs`** — no modo padrão o `payload` é comprimido por `compactWebhookPayload`
   (`middleware/webhookLogger.js:11`), que lê `body.messageId` / `body.media` (formato UltraMsg).
   O corpo da Whapi é `{ messages: [...] }`, então o resumo sai com `message_id` nulo e
   `has_media` falso: **não identifica a mídia perdida**, só prova que a entrega chegou. Se
   `WEBHOOK_LOG_FULL_PAYLOAD=1` estava ligado, a consulta **9b** lista os eventos de mídia sem
   `link` — prova direta. Consulta **9** diz em qual dos dois modos o log está.
4. **Logs do PM2** — o descarte era silencioso (`continue` sem log). Só o áudio sem URL loga
   (`[webhook] áudio inbound sem URL de mídia`). Para foto/vídeo/documento, o PM2 não ajuda.

### Recuperar: não precisa identificar uma por uma

`syncOldMessagesForConversation` pede o histórico do chat e **insere o que falta** (idempotente por
`whatsapp_id`). Basta chamá-la na conversa suspeita: o que o canal ainda guarda volta a existir,
com mídia. O mesmo caminho repara B e C de quebra.

**Por que `controllers/webhookInbound/historyImport.js` não serve aqui:** ele roda apenas quando o
inbound cria uma conversa **nova**, pega 25 mensagens e ainda ignora placeholder `(mídia)` sem URL.
É import de abertura, não ferramenta de reparo.

---

## 4. Gatilho do reparo em massa

Reaproveita o que existe; nenhum pipeline novo.

| Opção existente | Serve? |
|---|---|
| Botão "Buscar histórico" (`POST /chats/:id/mensagens-antigas` → `carregarMensagensAntigasContato`) | Sim, mas **uma conversa por clique** — bom para validar, inviável para o passivo |
| Backfill automático (`services/inboundMediaBackfillService.js`) | Só dispara no inbound ao vivo (trailing-debounce de 8s, teto de 3 simultâneos). Não varre o passado |
| Job da empresa (`syncOldMessagesForCompany`, tela de integração / `JOB_TIPOS.SYNC_MENSAGENS_ANTIGAS`) | Funciona, mas é muito mais pesado: `getChats` + até **5000 chats × 1000 mensagens**, **sem** a janela de 45 dias (não passa `timeFrom`) e **cria conversas** para chats que nem existem no sistema. Use só se quiser varredura total |
| **`scripts/reparar-midia-sem-link.js`** (novo) | Escolhido: toca **apenas as conversas afetadas**, é estritamente mais estreito que o job da empresa |

O script foi necessário porque nenhum gatilho existente sabe **quais** conversas estão quebradas.
Ele só decide a lista e o ritmo; o reparo é o serviço de sempre.

**Limites que ele respeita (e por quê):**

- **1 conversa por vez**, sem concorrência; `--pausa-ms=1500` entre chamadas (o sweep da empresa usa
  `CHAT_DELAY_MS=120ms`, agressivo demais para rodar junto com tráfego real);
- `--limite=50` conversas por execução — teto de consumo da conta;
- `--falhas-max=5` disjuntor por falhas **de provedor** seguidas (erro de conversa sem telefone não
  conta: não é motivo para abortar o lote);
- `--dias=45` alinhado à janela Whapi; acima disso o script **avisa** que o provedor não devolve nada;
- **dry-run por padrão**; `--company-id` obrigatório (isolamento app-layer);
- não passa por `scheduleInboundMediaBackfill`, então não interfere no debounce do caminho ao vivo —
  mas soma chamadas ao provedor: rodar fora do pico.

**Efeitos colaterais esperados:** mensagens inseridas **não** emitem socket (`io: null`) — o
atendente vê após recarregar; `conversas.ultima_atividade` pode **avançar** (só para frente,
`updateConversationActivity`) e a conversa sobe na lista; a cópia de mídia escreve em `/uploads`,
**por isso o script roda na VPS** — na máquina de desenvolvimento o arquivo cai no disco local e o
banco passa a apontar para um `/uploads/...` que não existe no servidor.

---

## 5. Ordem de execução

0. **Parar a sangria na origem:** incluir imagem, vídeo, documento e áudio em `media.auto_download`
   no canal Whapi. Independe de deploy e vale para todo evento novo.
1. **Medir:** `MIDIA_SEM_LINK_PASSIVO.sql`, consultas **1, 2, 3, 4, 10** (e 8/8b para o caso A).
   A consulta 4 responde se explodiu em 15/10 ou se é antigo; a 10 dá o veredito
   (`reparaveis` × `perdidas_fora_janela` × `perdidas_sem_whatsapp_id`).
2. **Deploy do código corrigido.** Antes dele, o reparo em massa quase não serve: o código antigo só
   reparava linha cujo texto fosse exatamente `(mensagem)`.
3. **Validar em uma conversa** (pegue um `conversa_id` da consulta 5):
   `--company-id=N --conversa=ID` (dry-run) e depois com `--apply`. Confira a bolha no atendimento.
4. **Lote:** `--company-id=N --apply --limite=50`, repetindo enquanto a consulta 10 baixar.
5. **Reconferir:** consulta 10 de novo. O que sobrar é o irreparável do §2.

---

## 6. Pendências / riscos residuais

- **Não verificado empiricamente** que `GET /messages/list/{chat}` da Whapi devolve `link` para tipo
  fora de `media.auto_download`. O código do backfill e o achado da auditoria indicam que sim
  (`mediaObj` em `services/providers/whapi/chatMessages.js:19` lê `link`), mas a prova é o passo 3
  acima: se o teste em uma conversa não trouxer mídia, o passivo do caso A é perda total e só o
  passo 0 tem efeito.
- **Bolha duplicada** em linha sem `whatsapp_id` (§2) — medir antes do lote.
- A consulta 8 (lacuna) tem falso positivo por natureza; não use como contagem de perdas, só para
  escolher conversas a tentar.
- Consultas 2–4 varrem `mensagens` (não há índice por `tipo`/`url`): reduza a janela se o SQL Editor
  estourar o tempo limite.
