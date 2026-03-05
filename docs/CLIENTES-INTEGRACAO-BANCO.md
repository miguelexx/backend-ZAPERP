# Integração de Clientes/Contatos com o Banco

## Fluxo de criação de clientes

Os contatos do celular (WhatsApp) são salvos na tabela `clientes` do Supabase de duas formas:

### 1. Webhook Z-API (mensagens recebidas/enviadas)
Quando chega ou é enviada uma mensagem:
- `getOrCreateCliente()` busca ou cria o cliente pelo telefone
- A conversa é vinculada ao cliente (`conversas.cliente_id`)
- O campo `ultimo_contato` do cliente é atualizado

### 2. Sincronização manual (Configurações → Clientes)
O botão "Sincronizar contatos" chama a Z-API para obter a lista de contatos do celular e insere em `clientes`.

## Verificação

### No banco (Supabase SQL Editor)
```sql
-- Total de clientes por empresa
SELECT company_id, COUNT(*) FROM clientes GROUP BY company_id;

-- Conversas sem cliente vinculado (podem indicar problemas)
SELECT id, telefone, cliente_id FROM conversas 
WHERE tipo != 'grupo' AND cliente_id IS NULL AND status_atendimento != 'fechada';

-- Últimos clientes criados
SELECT id, telefone, nome, pushname, company_id, criado_em 
FROM clientes ORDER BY criado_em DESC LIMIT 20;
```

### No sistema
1. **Configurações → Clientes**: Lista todos os clientes da tabela `clientes` (conectada ao banco).
2. **Atendimento**: Conversas individuais mostram nome/foto do cliente vinculado.

### Possíveis causas de clientes não aparecerem
1. **Telefone em formato não-BR**: Apenas números brasileiros (55 + DDD + número) são aceitos.
2. **Chave LID**: Mensagens espelhadas sem número real não criam cliente.
3. **company_id**: O webhook usa o `company_id` da instância Z-API; confira o vínculo em Configurações → WhatsApp.

## Correções implementadas
- Vincular conversa ao cliente quando obtida via LID (conversa existente sem `cliente_id`).
- Fallback de normalização de telefone para formatos alternativos.
- Atualização correta de `ultimo_contato` ao salvar mensagem.
