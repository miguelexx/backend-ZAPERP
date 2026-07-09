# Checklist de validação antes de apontar para o banco real do TGA

Use este checklist depois que o `.env` for atualizado com o caminho real,
e ANTES de rodar `run_sync_all.py` ou qualquer `sync_*.py` contra produção.

## 1. Teste de conexão somente leitura

- [ ] Rodar `python teste_conexao_producao.py`
- [ ] Confirmou "CONEXAO OK"
- [ ] `FIREBIRD_DATABASE` exibido no log é o caminho esperado (produção, não `TGA_TESTE`)
- [ ] Data da venda mais recente é de hoje ou dos últimos dias (não de meses atrás)
- [ ] Total de vendas (TMOV) é coerente com o que o time de operação espera

## 2. Tabelas e colunas exigidas pelos scripts (confirmar que existem no banco real)

| Script | Tabela(s) Firebird | Colunas usadas |
|---|---|---|
| `sync_fcfo.py` | `FCFO` | CODEMPRESA, CODCFO, NOMEFANTASIA, NOME, CODTIPOCFO, CGCCFO, INSCRESTADUAL, TIPO, RUA, NUMERO, COMPLEMENTO, BAIRRO, CIDADE, CODETD, CEP, TELEFONE, TELEFONE2, FAX, EMAIL, CONTATO, LIMITECREDITO, VALOREMABERTO, DATACRIACAO, DATAULTALTERACAO, DATAULTMOVIMENTO, ATIVO, CODVEN, IDCIDADE, CODREGIAO, CODTABPRECO, DATAULTVENDA, STATUSGE, ID, DATAHORAATUALIZACAO |
| `sync_produtos.py` | `TPRODUTO` + `TGRUPO` (LEFT JOIN) | CODEMPRESA, CODPRD, DESCRICAO, NOMEFANTASIA, CODBARRAS, CODGRUPO, TGRUPO.DESCRICAO, UNIDADE, PRECO1, CUSTOUNITARIO, CUSTOMEDIO, SALDOGERALFISICO, INATIVO, DATAULTALTERACAO, DATAHORAATUALIZACAO, ID |
| `sync_estoque.py` | `TPRODSALDO` | CODEMPRESA, CODFILIAL, CODLOC, CODPRD, SALDOFISICO1, CUSTOMEDIO, CUSTOUNITARIO, DATAMOVIMENTO, VALORFINANCEIRO1, ULTPRECOCOMPRA, DTULTIMACOMPRA, QTDULTIMACOMPRA |
| `sync_vendas.py` | `TMOV` | CODEMPRESA, IDMOV, CODFILIAL, CODLOC, CODCFO, NUMEROMOV, SERIE, CODTMV, TIPO, STATUS, DATAEMISSAO, DATASAIDA, DATAMOVIMENTO, CODVEN1, CODUSUARIO, VALORBRUTO, VALORLIQUIDO, VALORTOTALPRODUTO, VALORTOTALSERVICO, VALOROUTROS, VALORFRETE, VALORSEGURO, VALORDESC, VALORDESP, VALORRECEBIDO, VALORADIANTAMENTO, VALORTROCA, CODTABPRECO, NUMEROCUPOM, CHAVEACESSO, MODELODOCUMENTO, IDINTEGRACAO, ULTIMAALTERACAO |
| `sync_vendas_itens.py` | `TMOVITENS` | CODEMPRESA, IDMOV, NSEQ, CODPRD, QUANTIDADE, PRECOUNITARIO, PERCENTUALDESC, VALORDESC, PERCENTUALDESP, VALORDESP, DATAEMISSAO, CODUND, VALORTOTALITEM, DESCRICAO, STATUS, CODVEN1, PRECOTABELA, CODTABPRECO, PRECOBASE, CUSTOUNITARIO, VALORLIQUIDO, VALORUNITARIO, CUSTOMEDIO, DATAHORAINCLUSAO, DATAHORAALTERACAO |
| `sync_vendedores.py` | `TVENDEDOR` | CODEMPRESA, CODVEN, NOME, CARGO, CODFILIAL, CODLOC, COMISSAO1, COMISSAO2, COMISSAO3, INATIVO, EMAIL, TELEFONE1, TELEFONE2, CODCFO, STATUSGE, IDINTEGRACAO |

- [ ] Todas as tabelas acima existem no banco real
- [ ] Todas as colunas acima existem com o mesmo nome (Firebird é case-insensitive em maiúsculas por padrão, mas confirmar)
- [ ] Os tipos de dados são compatíveis com o que já está em `tga_*` no Supabase (datas como data/hora, valores como numérico)

> Se faltar alguma tabela/coluna, **não edite os scripts ainda** — apenas relate a diferença encontrada.

## 3. Pontos de atenção específicos antes do primeiro sync completo

- [ ] Confirmar se `CODEMPRESA` no banco real bate com os valores já existentes em `tga_*` no Supabase (evita misturar empresas diferentes sob o mesmo código)
- [ ] Confirmar se o primeiro sync será tratado como "sincronização completa" (sem `ultima_sync` em `sync_controle`) — isso vai puxar a tabela inteira. Para tabelas grandes (TMOV ~243k linhas, TMOVITENS ~764k linhas na cópia de teste), validar se o volume real é parecido ou muito maior.
- [ ] Decidir se vale truncar/zerar as tabelas `tga_*` no Supabase antes do primeiro sync real, para não misturar dados de teste com dados de produção (isso SERIA uma alteração de dados — não fazer sem sua autorização explícita).

## 4. Importante sobre `FIREBIRD_HOST`

`FIREBIRD_HOST` está no `.env` mas **não é usado por nenhum script hoje** —
`firebird.driver.connect()` não tem parâmetro `host`; a localização inteira
(local ou remota) vem do valor de `FIREBIRD_DATABASE`.

- Se o banco real estiver **nesta mesma máquina**, só mudar `FIREBIRD_DATABASE`
  para o novo caminho local (ex: `C:\TGA\GGFRUTAL.FDB`) é suficiente.
- Se o banco real estiver em **outro servidor/PC**, `FIREBIRD_DATABASE` precisa
  incluir o host, no formato `host/porta:caminho`, por exemplo:
  `192.168.0.50/3050:C:\TGA\GGFRUTAL.FDB`. Nesse caso `FIREBIRD_HOST` continua
  sem efeito a menos que eu faça um pequeno ajuste nos scripts para montar essa
  string a partir de `FIREBIRD_HOST` + `FIREBIRD_DATABASE` — ajuste mínimo,
  só farei se você confirmar que o banco é remoto.

## 5. O que me informar quando encontrar o banco real

- [ ] O banco está nesta máquina ou em outro servidor/PC da rede?
- [ ] Se for outro servidor: qual o nome/IP dele na rede local?
- [ ] Qual o caminho completo do arquivo `.FDB` (ex: `C:\TGA\GGFRUTAL.FDB`)?
- [ ] A porta do Firebird nesse servidor é a padrão (3050) ou outra?
- [ ] Usuário/senha são os mesmos (`SYSDBA`/`masterkey`) ou diferentes?
- [ ] O firewall desse servidor já libera a porta do Firebird para a rede (se for remoto)?
