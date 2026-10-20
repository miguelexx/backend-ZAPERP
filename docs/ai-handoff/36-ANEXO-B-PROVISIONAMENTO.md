# Anexo B — Provisionar, ativar e desligar uma empresa na integração WM

> Referência: [36-ORCAMENTO-WM-INTEGRACAO.md](36-ORCAMENTO-WM-INTEGRACAO.md) — seções **4** (as
> quatro identidades), **6** (persistência), **10** item **13** (prova de vínculo) e a **Sessão 3B**
> da seção 9. Contrato da WM: [`../wm/`](../wm/README.md).
>
> Este anexo é a ferramenta de **provisionamento** do vínculo `company_id → telefone autorizado da
> WM`. Há dois caminhos para a mesma operação e eles gravam na mesma linha:
>
> | Caminho | Onde | Valida na WM? |
> |---|---|---|
> | `scripts/wm-provisionar-empresa.js` | terminal com o `.env` | **sim** — chama `acesso/validar` |
> | bloco SQL deste anexo | Supabase Editor | **não** — use quando a validação já foi feita |

---

## 0. Antes de qualquer coisa — leia este parágrafo

O `ZAPERP_API_TOKEN` alcança **qualquer** empresa cadastrada na WM, e o **telefone é o único
seletor de tenant**. A WM declara que não fornece prova de vínculo (pendência 13 da seção 10):
`POST /acesso/validar` devolve só `{ "autorizado": true }`, o que prova que o telefone é aceito —
**não** que ele pertence à mesma empresa do `company_id` do ZapERP.

Consequência: **telefone errado nesta tabela = uma empresa lendo e gravando no ERP de outra.**
A conferência do vínculo é **humana**, feita com a WM, antes de ativar. É por isso que:

- não existe rota HTTP para isto e `orcamentos.configurar` não existe no catálogo (decisão **D7**);
- o vínculo nasce **desativado** nos dois caminhos, e ativar é um segundo passo consciente;
- `telefone_autorizado` nunca sai do servidor — o único recorte exibível é `telefone_ultimos4`
  (decisão **D1**). Não cole o telefone completo em chat, ticket ou log.

**Pré-requisito:** a migration `supabase/migrations/20261020120000_wm_orcamentos.sql` precisa estar
aplicada. Sem ela, qualquer um dos dois caminhos falha dizendo que não conseguiu gravar.

**O telefone é o contato autorizado que resolve a instalação do lado da WM** — não é o telefone da
conversa, nem o do comprador, nem o número WhatsApp conectado no ZapERP.

---

## 1. Caminho A — o script (valida na WM)

```bash
# ensaio: confere empresa, formato e WM; não grava
node scripts/wm-provisionar-empresa.js --company-id=1 --telefone=5534991847800 \
     --por="miguel/suporte" --dry-run

# gravação (nasce DESATIVADO)
node scripts/wm-provisionar-empresa.js --company-id=1 --telefone=5534991847800 \
     --por="miguel/suporte" --confirmar

# segundo passo, depois de conferir o vínculo com a WM: ativar (revalida o telefone gravado)
node scripts/wm-provisionar-empresa.js --company-id=1 --por="miguel/suporte" --ativar --confirmar
```

Pontos que importam:

- **`--confirmar` é obrigatório para gravar.** Não há confirmação interativa — o script roda em
  terminal não interativo. Sem a flag, ele valida tudo, mostra o que faria e sai sem escrever.
- **`--dry-run` vence `--confirmar`.** Útil para ensaiar o comando exato antes de executá-lo.
- **Recusa da WM não grava nada.** `403` (contato inexistente, inativo ou ambíguo), `401`
  (credencial), `400` (payload), timeout e `200` fora do contrato todos param com exit 1 e tabela
  intacta. Nunca "resolva" um `403` mexendo no nono dígito: a normalização brasileira é da WM
  ([`../wm/14-normalizacao-telefones.md`](../wm/14-normalizacao-telefones.md)).
- **Sem `WM_API_BASE_URL`/`ZAPERP_API_TOKEN` o script falha** em vez de gravar um vínculo não
  validado. Para gravar mesmo assim existe `--sem-validar`, que grava com
  `validacao_status = 'nao_validado'` e avisa em letras maiúsculas.
- **Trocar o telefone de uma empresa ativa a desativa.** Trocar o telefone é exatamente o momento em
  que um erro mandaria dados para outra empresa; religar é passo separado.
- A saída mostra **só os últimos 4 dígitos**, nunca o telefone, nunca o token.

---

## 2. Caminho B — SQL no Supabase Editor (NÃO valida na WM)

> Aqui não há chamada à WM. Use este caminho quando a validação **já foi feita** — pelo script, em
> outro ambiente, ou confirmada pela própria WM. Se ninguém validou, grave com
> `validacao_status = 'nao_validado'` e não ative.

### 2.1 Provisionar (INSERT ou UPDATE da mesma linha)

Edite **as quatro linhas do bloco `parametros`** e nada mais. `company_id` tem `UNIQUE`, então o
`ON CONFLICT` transforma isto no comando único de criar-ou-atualizar.

```sql
-- PROVISIONAR o vínculo da empresa com a API WM.
-- Grava DESATIVADO de propósito: ativar é o passo 2.3, depois de conferir o vínculo com a WM.
WITH parametros AS (
  SELECT
    1::int                        AS company_id,          -- <<< empresa do ZapERP
    '5534991847800'::text         AS telefone,            -- <<< contato autorizado da WM
    'miguel/suporte'::text        AS provisionado_por,    -- <<< quem está provisionando
    'autorizado'::text            AS validacao_status     -- <<< 'autorizado' só se a WM já validou;
                                                          --     senão, 'nao_validado'
),
empresa AS (  -- a empresa tem de existir; sem isto o INSERT falharia só pela FK, sem explicar
  SELECT p.* FROM parametros p
  JOIN public.empresas e ON e.id = p.company_id
)
INSERT INTO public.wm_orcamento_integracoes AS i (
  company_id, ativo, telefone_autorizado, telefone_ultimos4,
  validacao_status, validado_em, provisionado_por, atualizado_em
)
SELECT
  company_id,
  false,                                               -- nasce DESATIVADO
  telefone,
  right(regexp_replace(telefone, '\D', '', 'g'), 4),   -- telefone_ultimos4 derivado, sempre
  validacao_status,
  CASE WHEN validacao_status = 'autorizado' THEN now() ELSE NULL END,
  provisionado_por,
  now()
FROM empresa
ON CONFLICT (company_id) DO UPDATE SET
  telefone_autorizado = EXCLUDED.telefone_autorizado,
  telefone_ultimos4   = EXCLUDED.telefone_ultimos4,
  validacao_status    = EXCLUDED.validacao_status,
  validado_em         = EXCLUDED.validado_em,
  provisionado_por    = EXCLUDED.provisionado_por,
  atualizado_em       = now(),
  -- Telefone novo desativa a empresa. Religar é ação separada e consciente (2.3).
  ativo               = CASE
                          WHEN i.telefone_autorizado IS DISTINCT FROM EXCLUDED.telefone_autorizado
                            THEN false
                          ELSE i.ativo
                        END
RETURNING company_id, ativo, telefone_ultimos4, validacao_status, validado_em, provisionado_por;
```

Zero linhas retornadas = **a empresa não existe** no ZapERP. Confira o `company_id` em
`SELECT id, nome FROM public.empresas ORDER BY id;`.

### 2.2 Conferir o que ficou gravado (sem expor o telefone)

```sql
-- Estado do vínculo de todas as empresas. NÃO selecione telefone_autorizado.
SELECT
  i.company_id,
  e.nome                              AS empresa,
  i.ativo,
  '****' || coalesce(i.telefone_ultimos4, '????') AS telefone,
  length(regexp_replace(i.telefone_autorizado, '\D', '', 'g')) AS digitos_do_telefone,
  i.validacao_status,
  i.validado_em,
  i.provisionado_por,
  i.criado_em,
  i.atualizado_em
FROM public.wm_orcamento_integracoes i
LEFT JOIN public.empresas e ON e.id = i.company_id
ORDER BY i.company_id;
```

`digitos_do_telefone` é o único detalhe extra seguro: serve para detectar um telefone colado com
dígitos a mais ou a menos (a WM normaliza para 8–15 dígitos) **sem revelar o número**.

Checagem rápida de coerência — deve voltar **zero linhas**:

```sql
-- Linhas incoerentes: ativa sem validação, últimos 4 que não casam, ativa sem telefone.
SELECT company_id, ativo, validacao_status, telefone_ultimos4
FROM public.wm_orcamento_integracoes
WHERE (ativo = true AND validacao_status <> 'autorizado')
   OR (telefone_autorizado IS NOT NULL
       AND telefone_ultimos4 IS DISTINCT FROM right(regexp_replace(telefone_autorizado, '\D', '', 'g'), 4))
   OR (ativo = true AND coalesce(telefone_autorizado, '') = '');
```

### 2.3 ATIVAR a empresa (passo 2, depois da conferência humana)

```sql
-- Só ativa se a validação está registrada como 'autorizado' e existe telefone gravado.
UPDATE public.wm_orcamento_integracoes
   SET ativo = true,
       atualizado_em = now()
 WHERE company_id = 1                        -- <<< empresa
   AND validacao_status = 'autorizado'
   AND coalesce(telefone_autorizado, '') <> ''
RETURNING company_id, ativo, telefone_ultimos4, validacao_status;
```

Zero linhas = a guarda barrou: a empresa não está validada ou não tem telefone. Valide primeiro
(caminho A) em vez de remover a condição do `WHERE`.

A flag efetiva do módulo é **esta coluna `ativo` E a env global `WM_ORCAMENTOS_ENABLED`**
(decisão D2, `helpers/orcamentoWmFlag.js`). Ativar aqui com a env desligada não abre nada — e é
assim que o piloto fica contido.

### 2.3.1 ATIVAR em caráter PROVISÓRIO (sem validação na WM)

> Use só enquanto o `ZAPERP_API_TOKEN` não existir. Equivale ao `--sem-validar --ativar` do script.
> O módulo liga, a tela abre, e **qualquer chamada ao ERP falha** com "integração não configurada",
> porque sem token não há como falar com a WM. Serve para conferir a interface, não para operar.

O `UPDATE` de 2.3 **não serve aqui**: ele exige `validacao_status = 'autorizado'` de propósito, e
uma linha provisória está como `nao_validado`. A guarda está certa — não remova a condição dela.
Use este, que é explícito sobre o que está fazendo:

```sql
UPDATE public.wm_orcamento_integracoes
   SET ativo = true,
       atualizado_em = now()
 WHERE company_id = 1                        -- <<< empresa
   AND validacao_status = 'nao_validado'     -- provisório: ciente de que NÃO foi validado
   AND coalesce(telefone_autorizado, '') <> ''
RETURNING company_id, ativo, telefone_ultimos4, validacao_status;
```

Conferir o estado sem expor o telefone inteiro:

```sql
SELECT company_id, ativo, telefone_ultimos4, validacao_status, validado_em, provisionado_por
  FROM public.wm_orcamento_integracoes
 WHERE company_id = 1;
```

Quando o token chegar, rode o script **sem** `--sem-validar`: ele valida contra a WM e grava
`validacao_status = 'autorizado'`, e aí o caminho normal de 2.3 passa a valer.

Lembre que a validação da WM prova que existe um contato ativo com aquele telefone — **não** prova
que ele pertence a esta empresa (pendência 13). Essa conferência é humana.

### 2.4 DESATIVAR a empresa

```sql
UPDATE public.wm_orcamento_integracoes
   SET ativo = false,
       atualizado_em = now()
 WHERE company_id = 1                        -- <<< empresa
RETURNING company_id, ativo, telefone_ultimos4, validacao_status;
```

Isto é o desligamento normal: **preserva o telefone, a validação e todo o histórico de operações**.
É o que satisfaz o critério de aceite 16 da seção 12 ("a integração pode ser desligada por empresa
sem perder histórico operacional").

O efeito é quase imediato: o cache da flag é de 20 segundos
(`helpers/orcamentoWmFlag.js`) e não exige reinício da API.

### 2.5 REMOVER o vínculo

Só quando a empresa sai da integração de vez, ou quando o telefone foi gravado errado e não se quer
deixar rastro do valor na coluna. **Apaga o telefone e a validação; não apaga operações.**

```sql
-- Preferível: zerar o segredo e manter a linha (fica o registro de que a empresa já foi provisionada)
UPDATE public.wm_orcamento_integracoes
   SET ativo = false,
       telefone_autorizado = NULL,
       telefone_ultimos4 = NULL,
       validacao_status = 'nao_validado',
       validado_em = NULL,
       atualizado_em = now()
 WHERE company_id = 1                        -- <<< empresa
RETURNING company_id, ativo, telefone_ultimos4, validacao_status;
```

```sql
-- Remoção completa da linha. Confira o retorno do SELECT de 2.2 antes de rodar.
DELETE FROM public.wm_orcamento_integracoes
 WHERE company_id = 1                        -- <<< empresa
RETURNING company_id, telefone_ultimos4;
```

`wm_orcamento_operacoes` **não** é afetada por nenhum dos dois: as operações têm FK para `empresas`,
não para esta tabela. O histórico sobrevive — é o desenho, não um acidente.

---

## 3. Desprovisionamento / rollback por empresa

Desligar uma empresa tem de ser trivial, e **nenhum passo apaga histórico de operações**.

| Quando | Faça | Perde histórico? |
|---|---|---|
| Suspeita de telefone errado, incidente, piloto encerrado | **2.4** (`ativo = false`) — ou o script com `--desativar --sem-validar --confirmar` | não |
| Telefone errado gravado, quer tirar o valor da coluna | **2.5**, primeiro bloco (zera telefone e validação) | não |
| Empresa sai da integração de vez | **2.5**, segundo bloco (`DELETE`) | não (operações ficam) |
| Desligar o módulo para **todas** as empresas, agora | `WM_ORCAMENTOS_ENABLED=false` na API e reinício do PM2 | não |

Ordem recomendada num incidente de isolamento:

1. `WM_ORCAMENTOS_ENABLED=false` (mata o módulo inteiro, independe do banco);
2. `ativo = false` na empresa suspeita (**2.4**);
3. conferir o vínculo com a WM;
4. corrigir o telefone pelo caminho A (que revalida) e só então reativar (**2.3**).

Depois de desligar, confira que não sobrou empresa ativa:

```sql
SELECT company_id, ativo, validacao_status
FROM public.wm_orcamento_integracoes
WHERE ativo = true;
```

Preparações em voo não precisam de limpeza para desligar: sem `ativo`, o middleware
`requireOrcamentoWm` responde 403 e nenhuma preparação avança. Se quiser encerrar as pendentes:

```sql
-- Opcional: expira preparações que nunca vão ser confirmadas. NÃO mexe em ENVIANDO/INCERTO —
-- essas precisam de reconciliação (D10), e perder o comando_id é perder a idempotência.
UPDATE public.wm_orcamento_operacoes
   SET estado = 'EXPIRADO',
       atualizado_em = now()
 WHERE company_id = 1                        -- <<< empresa
   AND estado = 'PREPARADO'
RETURNING id, estado;
```

---

## 4. O que NÃO fazer por SQL

- **Não** `SELECT telefone_autorizado` — nem para "só conferir". Use `telefone_ultimos4` e, se
  precisar de mais, o `length(...)` de 2.2. O resultado de um editor vai para a tela, para o
  histórico do navegador e eventualmente para um print em chat.
- **Não** ativar uma empresa com `validacao_status <> 'autorizado'` removendo a condição do `WHERE`
  de 2.3. A condição é a última defesa antes de uma empresa falar com o ERP de outra.
- **Não** criar linha para um `company_id` que não existe em `empresas` (a FK barra, e o bloco 2.1
  já explica em vez de deixar o erro cru).
- **Não** mexer em `comando_id`, `payload_criacao` ou `payload_hash` de `wm_orcamento_operacoes`:
  são a idempotência da criação no ERP (seção 7 e decisão D4).
- **Não** usar este anexo para "configurar pelo painel". Não existe painel para isto, de propósito
  (**D7**), e não é por falta de código.
