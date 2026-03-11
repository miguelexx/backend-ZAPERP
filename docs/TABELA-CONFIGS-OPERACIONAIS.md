# Tabela de Configurações Operacionais

## configuracoes_operacionais

| Coluna | Tipo | Default | Descrição |
|--------|------|---------|-----------|
| company_id | integer | - | FK empresas |
| sync_auto | boolean | false | Sync automático ao conectar |
| lote_max | integer | 50 | Máximo de itens por lote |
| intervalo_lotes_seg | integer | 5 | Segundos entre lotes |
| pausa_blocos_seg | integer | 30 | Pausa entre blocos |
| concorrencia_max | integer | 2 | Jobs simultâneos por empresa |
| retry_max | integer | 3 | Tentativas máximas por job |
| cooldown_erro_seg | integer | 60 | Cooldown após erro |
| modo_seguro | boolean | true | Operação conservadora |
| somente_atendimento_humano | boolean | false | Desativa automações |
| processamento_pausado | boolean | false | Pausa todos os jobs |

## Endpoints

- `GET /config/operacional` — retorna config da empresa (cria com defaults se não existir)
- `PUT /config/operacional` — atualiza campos permitidos
