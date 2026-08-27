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

## Os demais arquivos

`APAGAR_DADOS_COMPANY_4.sql`, `EXCLUIR_CLIENTE_ESPECIFICO.sql`, `EXCLUIR_CONVERSAS_LISTA_ESPECIFICA.sql`,
`EXCLUIR_TODOS_CLIENTES_COMPANY_4.sql`, `LIMPAR_CONVERSAS_CLIENTES.sql` fazem `DELETE` em massa.

`EXCLUIR_TODOS_CLIENTES_COMPANY_4.sql` limpa **clientes + conversas + mensagens** só da empresa 4
(não apaga usuários, instâncias nem campanhas). Rode o `SELECT` de preview, depois o bloco com
`v_aplicar := false` (DRY_RUN). Só mude para `true` depois de conferir. Não use
`APAGAR_DADOS_COMPANY_4.sql` para este caso: aquele também apaga usuários e departamentos.

`AUTO_CONFIGURE_CHATBOT_ALL_COMPANIES.sql`, `CONFIGURE_CHATBOT_EMPRESA_2.sql`,
`FIX_OPCAO_INVALIDA_RPC_SUPABASE.sql`, `QUICK_CHATBOT_SETUP.sql`, `VERIFY_OPCAO_INVALIDA_SETUP.sql`,
`EXEMPLOS_PRATICOS_CHATBOT.sql` fazem `INSERT`/`UPDATE`/`DELETE` pontuais de configuração de chatbot —
revise os IDs de empresa antes de rodar.

Scripts só-leitura (diagnóstico/auditoria, sem risco de alterar dados) ficam em `../diagnostico/`.
