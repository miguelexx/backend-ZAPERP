# Relatório: Correção do Bug "Ao Enviar Msg, Nome do Contato Muda/Piora"

## Resumo

Correção aplicada para garantir que o sistema **nunca substitua um nome "bom" por um "pior" ou não confiável**, evitando regressão de nomes ao enviar mensagens (ReceivedCallback fromMe, DeliveryCallback, etc.).

## Alterações Realizadas

### 1. Novo Helper: `helpers/contactEnrichment.js`

- **`normalizeName(name)`**: trim, colapsar espaços, remover caracteres estranhos
- **`isBadName(name)`**: detecta nomes ruins (vazio, "sem conversa", "unknown", parecem telefone, muito curtos)
- **`scoreName(name, source)`**: score por fonte (senderName:100, chatName:80, pushname:60, syncZapi:90)
- **`chooseBestName(currentName, candidateName, source, opts)`**: escolhe o melhor nome; nunca substitui bom por pior; em `fromMe` só aceita `senderName` como candidato para trocar

### 2. Aplicação em `getOrCreateCliente` (`helpers/conversationSync.js`)

- Antes de UPDATE em `clientes`: calcula `bestNome = chooseBestName(existente.nome, fields.nome, fields.nomeSource, { fromMe, company_id, telefoneTail })`
- Só atualiza `nome` se `bestNome` for diferente e melhor
- INSERT: não usa `fields.nome` se for `isBadName()`

### 3. Aplicação em `nome_contato_cache` (conversas)

- **webhookZapiController ReceivedCallback**: cache de nome usa `chooseBestName(convAtual.nome_contato_cache, senderName, source, { fromMe })`
- **mergeConversationLidToPhone**: quando `opts.nomeCache` é passado, usa `chooseBestName` antes de atualizar

### 4. Remoção de enriquecimento em STATUS e PRESENCE

- **DeliveryCallback**: `mergeConversationLidToPhone` chamado **sem** `nomeCache`/`fotoCache` — apenas merge LID→PHONE
- **DeliveryCallback** (conversão LID→telefone): `getOrCreateCliente` chamado com `{}` — sem enriquecer nome
- **MessageStatusCallback**: já não passava nome (apenas `{ io }`)
- **PresenceChatCallback**: não atualiza nome (apenas typing/online)

### 5. Correção do source durante fromMe

- ReceivedCallback: `nomeSource = fromMe ? 'chatName' : 'senderName'`
- Em `chooseBestName`, quando `fromMe=true`: só atualiza se `source === 'senderName'` (alta confiança)

### 6. Log DEV `[NAME_UPDATE]`

- Ativado com `WHATSAPP_DEBUG=true`
- Formato: `{ company_id, telefoneTail, currentName, candidateName, source, decision: "kept"|"updated" }`
- Não loga telefones completos nem tokens

## Prova de Log

Com `WHATSAPP_DEBUG=true`, ao enviar mensagem para contato "Papai" (já correto):

```
[NAME_UPDATE] { company_id: 2, telefoneTail: '80098', currentName: 'Papai', candidateName: '...', source: 'chatName', decision: 'kept' }
```

## Query de Verificação (DB)

```sql
SELECT nome FROM clientes WHERE company_id = 2 AND telefone LIKE '%80098';
```

Após envio de mensagem, o nome deve permanecer "Papai" (ou o valor correto anterior).

## Arquivos Modificados

| Arquivo | Alteração |
|---------|-----------|
| `helpers/contactEnrichment.js` | **Novo** — helper chooseBestName |
| `helpers/conversationSync.js` | chooseBestName em getOrCreateCliente e mergeConversationLidToPhone |
| `controllers/webhookZapiController.js` | nomeSource/fromMe, cache com chooseBestName, remoção de nome em DeliveryCallback, pendingContactSync, setImmediate grupo |
| `controllers/chatController.js` | chooseBestName em sincronizarFotosPerfilZapi e createConversaFromChat sync |
| `services/zapiContactsSyncService.js` | nomeSource: 'syncZapi' em getOrCreateCliente |

## Compatibilidade com company_id=1

O company 1 não foi alterado em lógica específica. O fluxo é o mesmo para todos os tenants; a regra `chooseBestName` aplica-se a todos. Recomenda-se rodar um teste simples de envio/recebimento no company 1 para validar.
