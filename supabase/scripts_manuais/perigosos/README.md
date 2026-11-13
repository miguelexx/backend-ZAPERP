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

## `COMPANY_3_*.sql` — zerar o histórico da empresa 3

Mesmo escopo e mesma lista `manter`/`v_manter` dos `COMPANY_31_*` (zera dados operacionais,
preserva atendentes, acesso, conexão e configuração), já parametrizado para a empresa 3, com duas
melhorias que valem para qualquer limpeza futura — **prefira copiar estes, não os `COMPANY_31_*`**:

| Arquivo | O que faz |
|---|---|
| `COMPANY_3_0_MENSAGENS_EM_LOTES.sql` | Opcional, só se `mensagens` da empresa passar de ~500 mil linhas. |
| `COMPANY_3_1_SIMULAR.sql` | **Só leitura.** Primeira linha mostra o **nome** da empresa 3 — confira antes. Rode antes e depois. |
| `COMPANY_3_2_APAGAR.sql` | Apaga o histórico. Bloco único = transação única; travou FK ou sobrou linha, faz rollback de tudo. |
| `COMPANY_3_3_USUARIOS_SIMULAR.sql` | **Só leitura.** Lista os usuários da empresa (`MANTER`/`APAGAR`) e o efeito por FK (`SET NULL`/`APAGAR LINHA`). |
| `COMPANY_3_4_USUARIOS_APAGAR.sql` | Remove os atendentes da empresa **exceto** os ids de `v_manter_ids`. Rode depois do `_2_`. |

Os `_3_`/`_4_` existem porque o editor de tabelas do Supabase não consegue excluir usuário
referenciado por FK (`Unable to delete rows as one of them is currently referenced by a foreign key
constraint from the table atendimentos`). São 60+ FKs apontando para `usuarios`, então o script
varre `pg_constraint`: coluna que aceita NULL vira `SET NULL` (a linha filha sobrevive sem o
vínculo), coluna `NOT NULL` faz a linha filha ser apagada — e só se ela for da empresa alvo ou sem
`company_id`, nunca de outra empresa.

1. **Linhas órfãs/cross-tenant.** A ETAPA A dos `COMPANY_31_*` só olhava filha **sem** `company_id`.
   Aqui ela também apaga a linha de uma filha **com** `company_id` que esteja órfã (`company_id`
   NULL, legado anterior ao hardening multi-tenant) ou de outra empresa apontando para um registro
   da empresa alvo. É o caso real de `atendimentos` com `company_id` NULL, que fazia o script
   abortar com `violates foreign key constraint "atendimentos_para_usuario_id_fkey"`. O relatório
   marca essas linhas com `(orfas/cross-tenant)`.
2. **Erro de FK legível.** Ao abortar, a exceção cita a última tabela e a mensagem do Postgres,
   em vez de só "ainda havia FK bloqueando".

Para preservar/zerar mais alguma coisa, mexa na tabela nas **duas** listas — `manter` no simular e
`v_manter` no apagar. Para descontinuar a empresa de vez (apagar `usuarios` e `whatsapp_instances`),
deixe as duas listas só com `empresas`. Para outra empresa, troque o `3` em `cfg` (simular) e
`v_company` (apagar). Não apaga a mídia no R2/Storage e não desativa a instância no painel do
provider.

## Os demais arquivos

`APAGAR_DADOS_COMPANY_4.sql`, `EXCLUIR_CLIENTE_ESPECIFICO.sql`, `EXCLUIR_CONVERSAS_LISTA_ESPECIFICA.sql`,
`EXCLUIR_CLIENTES_SO_NUMERO_COMPANY_4.sql`, `EXCLUIR_TODOS_CLIENTES_COMPANY_4.sql`, `LIMPAR_CONVERSAS_CLIENTES.sql` fazem `DELETE` em massa.
`AUTO_CONFIGURE_CHATBOT_ALL_COMPANIES.sql`, `CONFIGURE_CHATBOT_EMPRESA_2.sql`,
`FIX_OPCAO_INVALIDA_RPC_SUPABASE.sql`, `QUICK_CHATBOT_SETUP.sql`, `VERIFY_OPCAO_INVALIDA_SETUP.sql`,
`EXEMPLOS_PRATICOS_CHATBOT.sql` fazem `INSERT`/`UPDATE`/`DELETE` pontuais de configuração de chatbot —
revise os IDs de empresa antes de rodar.

Scripts só-leitura (diagnóstico/auditoria, sem risco de alterar dados) ficam em `../diagnostico/`.
