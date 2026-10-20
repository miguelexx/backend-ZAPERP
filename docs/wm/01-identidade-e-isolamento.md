# Identidade e isolamento

## IMPLEMENTADO — regra empresarial do MVP

```text
1 banco Icthus = 1 CNPJ = 1 empresa cloud = 1 Sincronizador
```

No modelo operacional do MVP, cada banco Icthus contém uma única empresa com
Código Empresa = 1. Outro CNPJ/filial utiliza outro banco, novamente com código 1.
Esse código é local ao banco e não identifica globalmente cliente, não
autentica e não deve ser tenant cloud. CNPJ identifica/confere a empresa, mas
também não é credencial. Isolamento cloud usa empresa_id e sincronizador_id.

O cadastro administrativo aceita somente nome e CNPJ. A API atribui
empresas.codigo_erp = 1 no INSERT; o Painel não informa nem edita esse campo.
A coluna continua INTEGER NOT NULL e presente nas respostas, sem default no
PostgreSQL. Edições preservam o código armazenado, inclusive valores legados.
O Worker continua lendo dbo.Empresas.[Código Empresa] e usando
EmpresaLocal.CodigoEmpresa nas escritas, sem assumir literal 1.

**011: APLICADA E VALIDADA NO POSTGRESQL CLOUD**, conforme confirmação da WM nesta Etapa 3. Não foi reaplicada nem houve acesso ao cloud nesta entrega.
UNIQUE(codigo_erp) foi removido; CNPJ é normalizado/único e empresa_id do sincronizador é único.

## IMPLEMENTADO — contexto autenticado

[localizarPorToken](../src/modules/sincronizadores/sincronizadores.repository.ts)
calcula SHA-256 do Bearer token e consulta sincronizadores ativos.
O backend obtém sincronizador.id e empresa_id desse registro.
Não usa CNPJ ou código ERP informado no request para autenticar.

O Assistente exige credencial Bearer própria do consumidor (n8n ou backend ZapERP)
e resolve telefone normalizado/ativo em
assistente_contatos → sincronizador_id, através do módulo contexto.
O telefone é único globalmente no modelo atual. A confiança na origem desse
telefone depende do consumidor autenticado; não é identidade administrativa.
Normalização canônica brasileira, equivalências conservadoras e conflitos
legados estão documentados em [normalização de telefones](14-normalizacao-telefones.md).

Vendas usam (sincronizador_id, empresa_codigo_erp, codigo_pedido_erp);
produtos usam (sincronizador_id, codigo_produto_erp). Códigos ERP continuam úteis
nessas chaves locais, sem substituir o contexto do backend.

## IMPLEMENTADO — identidade cloud/local

GET /api/v1/sincronizadores/identidade resolve token → sincronizador ativo →
empresa → CNPJ. Nenhum ID, código ERP ou CNPJ do request seleciona o contexto.
O Worker compara a identidade local de dbo.Empresas com a cloud antes do primeiro
ciclo operacional ou conexão WSS. Orçamento também exige essa guarda central.
Sucesso fica válido por processo; divergência/token inválido bloqueiam até reinício.
Falha temporária de API não equivale a divergência e pode recuperar pelos loops existentes.

## DEFINIDO / A IMPLEMENTAR — instâncias

```text
Mesma máquina Windows
├── WM_EMPRESA_A → CNPJ A → sincronizador A → processo/configuração A
└── WM_EMPRESA_B → CNPJ B → sincronizador B → processo/configuração B
```

São instâncias independentes do mesmo Worker, não um Worker multiempresa.
Serviços/configuração por instância ainda não estão implementados.
Múltiplos sincronizadores por empresa e seleção multiempresa no mesmo banco
ficam **FUTURO / FORA DO MVP**.
