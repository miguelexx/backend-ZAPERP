# Diagnóstico — Mensagem Inicial do Chatbot Não Aparece

**Problema:** Quando um contato envia mensagem, a mensagem de boas-vindas configurada não é enviada.

**Escopo:** Chatbot funciona **apenas para contatos** (não grupos).

---

## Correções Implementadas

1. **Telefone LID:** Quando o payload traz `phone` como LID (`lid:xxx`), o backend agora tenta usar o `telefone` da conversa no banco. Se não houver número real, o chatbot é ignorado (não é possível enviar via Z-API para LID).

2. **Logs de diagnóstico:** Foram adicionados logs para rastrear o fluxo:
   - `[Z-API] 🤖 Chatbot: processando mensagem` — chatbot foi acionado
   - `[chatbotTriage] skip: ...` — motivo de não processar (config, telefone, etc.)
   - `[chatbotTriage] getChatbotConfig: sem registro` — não há `ia_config` para o `company_id`
   - `[chatbotTriage] menu vazio` — `welcomeMessage` e opções estão vazios

---

## Checklist de Verificação

### 1. Webhook Z-API configurado
- [ ] No painel Z-API, a URL do webhook está: `https://SEU-DOMINIO/webhooks/zapi` (ou `/webhook/zapi`)
- [ ] O webhook está ativo e recebendo eventos

### 2. empresa_zapi
- [ ] Existe registro em `empresa_zapi` com `instance_id` da sua instância Z-API
- [ ] O `company_id` está correto (mesma empresa em que você configurou o chatbot)
- [ ] `ativo = true`

```sql
SELECT company_id, instance_id, ativo FROM empresa_zapi WHERE ativo = true;
```

### 3. ia_config salvo
- [ ] Você clicou em **"Salvar configuração"** na página do chatbot
- [ ] O `company_id` do usuário logado é o mesmo do webhook

```sql
SELECT company_id, config->'chatbot_triage'->>'enabled' as enabled,
       jsonb_array_length(COALESCE(config->'chatbot_triage'->'options', '[]'::jsonb)) as opcoes
FROM ia_config;
```

### 4. Opções válidas
- [ ] Pelo menos 1 opção com `key` preenchido (ex: "1", "2")
- [ ] Cada opção tem `departamento_id` selecionado
- [ ] Opções estão ativas (checkbox marcado)

**Importante:** A primeira opção na sua configuração tinha **Key vazio**. Defina como "1" para que a resposta "1" do cliente funcione.

### 5. Mensagem de boas-vindas
- [ ] O campo "Mensagem de boas-vindas" não está vazio
- [ ] Ou há opções no menu (o sistema monta o menu automaticamente)

---

## Como Debugar

1. **Reinicie o backend** e envie uma mensagem de teste de um contato.

2. **Verifique os logs do servidor.** Procure por:
   - `[Z-API] 🤖 Chatbot: processando mensagem` → chatbot foi acionado
   - `[chatbotTriage] skip: config não encontrada` → não há `ia_config` ou config inválida
   - `[chatbotTriage] skip: chatbot desativado` → `enabled: false`
   - `[chatbotTriage] skip: nenhuma opção configurada` → options vazias ou sem departamento_id
   - `[chatbotTriage] getChatbotConfig: sem registro` → tabela `ia_config` sem linha para o `company_id`

3. **Verifique os logs em GET /api/ia/logs.** Se aparecer `menu_enviado`, o envio funcionou.

4. **Teste o mapeamento instanceId → company_id:**
   - Envie uma mensagem e confira no log: `companyId: X` no `[ZAPI_WEBHOOK]`
   - Confira se esse `X` é o mesmo `company_id` da empresa em que você configurou o chatbot

---

## Resumo

O chatbot só processa mensagens quando:
- `!fromMe` (não é mensagem enviada por você)
- `!isGroup` (não é grupo)
- `departamento_id == null` (conversa ainda não roteada)
- `phone` é um número válido para envio (não LID sem número real)
- Config existe, `enabled: true`, e há opções válidas
