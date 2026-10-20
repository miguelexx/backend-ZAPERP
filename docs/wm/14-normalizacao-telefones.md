# Normalização e equivalência de telefones

## Auditoria e escopo

A tabela `assistente_contatos` (migration 006) possui `telefone VARCHAR(15)`,
`UNIQUE(telefone)` global, FK de Sincronizador e indicador de contato ativo.
A migration 007 exige de 8 a 15 dígitos. Antes desta correção, POST/PATCH
apenas removiam caracteres não numéricos; autorização usava igualdade exata.
Assim, o banco admite formatos nacionais, internacionais e celulares legados,
mas não máscaras. Não foi acessado banco de produção nesta tarefa.

A regra central está em `src/shared/validation/telefone.ts`. Cadastro e PATCH
usam `normalizarTelefone`; autorização e verificação de unicidade usam
`candidatosTelefone`. Todas as rotas do Assistente, incluindo relatórios,
continuam passando pelo mesmo resolver de contexto. O telefone não escolhe
empresa por um ID recebido no body: o vínculo vem do contato no banco.

## Formato e limites conservadores

Brasileiros identificáveis são persistidos como `55 + DDD + número atual`,
somente dígitos. São aceitos DDD + número e DDI 55 + DDD + número,
com espaços, parênteses, pontos, hífens e sinal `+` inicial.

- DDD precisa existir no plano brasileiro.
- Fixo: oito dígitos iniciados em 2, 3, 4 ou 5. Acrescenta-se somente DDI
  quando necessário; jamais se acrescenta ou remove 9.
- Celular atual: nove dígitos iniciados em 9.
- Celular legado: oito dígitos iniciados em 6, 8 ou 9. Acrescenta-se 9.
- A remoção do nono dígito só gera candidato se o restante iniciar em 6, 8
  ou 9. A faixa 7 é deliberadamente excluída, pois pode ser rádio/trunk;
  demais faixas também não recebem equivalência de celular.
- DDI explícito diferente de 55, DDD inválido, comprimento não reconhecido
  ou sintaxe fora desse escopo mantêm a normalização histórica: somente
  dígitos, de 8 a 15. Não se aplica nono dígito brasileiro a essas entradas.
- Número local sem DDD não ganha DDD nem DDI inferido.

Exemplo: `(34) 99184-7800`, `34991847800` e `553491847800` normalizam
para `5534991847800`. Os candidatos são `5534991847800`, `34991847800`,
`553491847800` e `3491847800`, permitindo leitura de registros anteriores.

A distinção fixo/celular e a adição histórica do 9 seguem referências da
[Anatel sobre numeração](https://www.gov.br/anatel/pt-br/regulado/numeracao/perguntas-frequentes)
e [implementação do nono dígito](https://www.gov.br/anatel/pt-br/regulado/numeracao/codigos-nacionais/nono-digito).
As equivalências são uma política conservadora da API, não verificação da
existência ou titularidade de um número nem garantia do formato de todos os JIDs.

## Autorização, unicidade e transição

A consulta parametrizada usa candidatos exatos e o índice existente; não
remove dígitos em SQL nem varre contatos com normalização por linha.
Somente um contato encontrado e ativo autoriza. Dois registros equivalentes,
mesmo do mesmo Sincronizador ou com um inativo, retornam
`403 CONTATO_NAO_AUTORIZADO`. O diagnóstico registra somente
`CONFLITO_EQUIVALENCIA_TELEFONE`, sem telefone, nome, IDs ou payload.

POST e PATCH de telefone fazem a verificação global de todos os candidatos
em transação. Um advisory lock transacional baseado na identidade canônica
serializa gravações concorrentes equivalentes. Conflito, inclusive contra
contato legado ou inativo, mantém `409 TELEFONE_JA_CADASTRADO`.
PATCH ignora somente o próprio contato; vínculo da URL permanece obrigatório.
PATCH sem telefone preserva o valor antigo, sem migrá-lo implicitamente.

Não é necessária migration para as gravações feitas pela API atualizada.
A constraint existente continua protegendo igualdade literal; equivalência
é garantida pelo fluxo transacional da API. Escritas diretas no banco ou
instâncias antigas ignoram esse protocolo: o rollout deve impedir que versões
antigas continuem cadastrando contatos. Caso surjam outros escritores,
reavaliar uma constraint de identidade canônica após auditar colisões.

Nenhum contato foi apagado, fundido ou normalizado em lote. Uma manutenção
futura deve agrupar colisões canônicas, revisar os vínculos manualmente e
resolver conflitos antes de atualizar dados. O banco não guarda o país de
origem separado: sequências sem DDI explícito que se pareçam com DDD+número
brasileiro são interpretadas como nacionais; formatos internacionais legados
ambíguos exigem revisão humana. Conflitos detectados falham fechado.

O Painel, n8n, Evolution, Worker e Sincronizador não precisam ser alterados.
O Painel já pode enviar somente dígitos ou formato mascarado, e mostrar a
resposta canônica. Não houve commit, push, deploy nem acesso a produção.
