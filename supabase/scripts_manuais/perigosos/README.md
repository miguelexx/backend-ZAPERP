# ⚠️ Scripts manuais perigosos — NÃO são migrations

Os arquivos desta pasta **não fazem parte do histórico de migrations** (`backend/supabase/migrations/`)
e **não rodam automaticamente em nenhum lugar**. São scripts pontuais escritos para resolver um problema
específico em um momento específico (ex.: limpar dados de teste de uma empresa, corrigir um registro).

**Antes de rodar qualquer arquivo daqui no SQL Editor do Supabase:**

1. Leia o script inteiro e confirme que ele faz exatamente o que você precisa agora — muitos têm
   `company_id`/IDs fixos de uma situação passada (ex.: `COMPANY_4`, `EMPRESA_2`) que provavelmente
   **não se aplicam ao seu caso atual**.
2. Tire um backup/snapshot do banco antes de rodar qualquer `DELETE`.
3. Rode primeiro só os `SELECT` do script (se houver) para conferir o que seria afetado.

## `RUN_IN_SUPABASE.sql`

Script de setup histórico (criação de colunas/tabelas antigas). As linhas que reintroduziam
`company_id DEFAULT 1` em 9 tabelas foram **comentadas em 2026-06-30** porque desfaziam o hardening
multi-tenant aplicado em `backend/supabase/migrations/20260630120000_rls_company_id_hardening.sql` e
`20260630130000_drop_remaining_company_id_defaults.sql`. Se for reaproveitar partes deste script,
**não reative essas linhas**.

## `COMPANY_31_*.sql` — limpar uma empresa preservando os atendentes

Zera **todos os dados operacionais** de uma empresa (conversas, mensagens, clientes, atendimentos,
logs, disparos, helpdesk, chat interno, auditoria) **preservando os atendentes** (`usuarios`),
o acesso deles (`departamentos`, `usuario_*`) e a conexão (`whatsapp_instances`).

| Arquivo | O que faz |
|---|---|
| `COMPANY_31_1_SIMULAR.sql` | **Só leitura.** Relatório `MANTER`/`APAGAR` por tabela. Rode antes e depois. |
| `COMPANY_31_2_APAGAR.sql` | Apaga. Bloco único = transação única; sobrou linha, faz rollback de tudo. |
| `COMPANY_31_0_MENSAGENS_EM_LOTES.sql` | Opcional, só se `mensagens` for grande demais para uma transação. |

Diferente do `APAGAR_DADOS_COMPANY_4.sql` (que apaga `usuarios` e `departamentos`), estes **não**
usam lista fixa de tabelas: varrem o `information_schema` em tempo de execução e apagam de toda
tabela com `company_id` fora da lista `v_manter`, mais as filhas sem `company_id` presas por FK
`NO ACTION`/`RESTRICT`. Rodam em várias passadas, resolvendo a ordem de FK sozinhos.

Para outra empresa: troque o `31` em `cfg` (simular) e em `v_company` (apagar) — e mantenha as duas
listas `v_manter`/`manter` iguais, senão o relatório deixa de bater com a exclusão.

**Não apaga a mídia no R2/Storage** — só as linhas de `mensagens`.

⚠️ **Formato:** os blocos usam `$$` e nunca `$1` ou dollar-quote nomeado (`$nome$`) por dentro.
O SQL Editor do Supabase não reconhece esses dois e quebra o statement no `;` errado, gerando
`42601: unterminated dollar-quoted string`. Se for editar, mantenha essa restrição.

## Os demais arquivos

`APAGAR_DADOS_COMPANY_4.sql`, `EXCLUIR_CLIENTE_ESPECIFICO.sql`, `EXCLUIR_CONVERSAS_LISTA_ESPECIFICA.sql`,
`EXCLUIR_CLIENTES_SO_NUMERO_COMPANY_4.sql`, `EXCLUIR_TODOS_CLIENTES_COMPANY_4.sql`, `LIMPAR_CONVERSAS_CLIENTES.sql` fazem `DELETE` em massa.
`AUTO_CONFIGURE_CHATBOT_ALL_COMPANIES.sql`, `CONFIGURE_CHATBOT_EMPRESA_2.sql`,
`FIX_OPCAO_INVALIDA_RPC_SUPABASE.sql`, `QUICK_CHATBOT_SETUP.sql`, `VERIFY_OPCAO_INVALIDA_SETUP.sql`,
`EXEMPLOS_PRATICOS_CHATBOT.sql` fazem `INSERT`/`UPDATE`/`DELETE` pontuais de configuração de chatbot —
revise os IDs de empresa antes de rodar.

Scripts só-leitura (diagnóstico/auditoria, sem risco de alterar dados) ficam em `../diagnostico/`.
