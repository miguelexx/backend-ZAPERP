# Proteção de envio (rate limit + opt-in)

> Atualizado: **2026-08-24** · branch `master`.  
> Arquivos: `services/protecao/` (4 arquivos).

---

## Estado atual: **DESATIVADO globalmente**

```js
// services/protecao/protecaoOrchestrator.js
const PROTECAO_DESATIVADA = true   // ← kill switch; retorna { allow: true } imediatamente
```

**Todo envio passa livre.** O sistema de proteção está implementado mas intencionalmente desligado. Ativar sem entender o impacto pode bloquear mensagens de atendimento normal.

---

## O que o módulo faz (quando ativado)

Antes de cada envio via `chatController`, o orquestrador verifica três camadas em sequência:

| Camada | Arquivo | O que verifica |
|--------|---------|----------------|
| Volume | `volumeService.js` | Conta mensagens `out` da empresa no último minuto e na última hora. Bloqueia se acima do limite configurado. |
| Frequência | `frequenciaService.js` | Verifica se existe mensagem `out` para a mesma conversa nos últimos N segundos. Bloqueia envio muito rápido ao mesmo contato. |
| Opt-in | `optInService.js` | Confirma se o contato tem opt-in ativo em `contato_opt_in`. Só exigido quando `requireOptIn=true` (campanhas comerciais). |

Todas as verificações são **fail-open**: erro na consulta → envio liberado.

---

## Configuração por empresa

As colunas abaixo em `empresas` controlam os limites (quando a proteção está ativa):

| Coluna | Tipo | Significado | Padrão (código) |
|--------|------|-------------|-----------------|
| `intervalo_minimo_entre_mensagens_seg` | int | Intervalo mínimo entre envios ao mesmo contato | `1s` |
| `limite_por_minuto` | int | Máx de mensagens `out` por minuto (empresa toda) | `40` |
| `limite_por_hora` | int | Máx de mensagens `out` por hora (empresa toda) | `400` |

Valor `0` explícito desativa aquela proteção específica para a empresa. `null` usa defaults do código.

---

## Feature flag adicional

Quando `FEATURE_PROTECAO` (em `helpers/featureFlags.js`) está desligada, o orquestrador usa os defaults leves acima (chat fluido) em vez dos valores brutos da empresa. Com `FEATURE_PROTECAO` ativo, usa exatamente os valores configurados na empresa.

Isso só tem efeito se `PROTECAO_DESATIVADA` for `false`.

---

## Tabelas usadas

| Tabela | Leitura/escrita | Propósito |
|--------|----------------|-----------|
| `mensagens` | leitura | Contar mensagens `out` por empresa/conversa/período |
| `empresas` | leitura | Limites configurados por empresa |
| `contato_opt_in` | leitura | Verificar consentimento de envio comercial |
| `contato_opt_out` | leitura/escrita | Gerenciada por `disparoOptOutService` e `optInOptOutController` |

---

## APIs de opt-in/opt-out

| Rota | Acesso | Efeito |
|------|--------|--------|
| `POST /opt-in` | `auth + supervisorOrAdmin` | Upsert em `contato_opt_in` com `{ cliente_id, origem='manual' }` |
| `GET /opt-out` | `auth + supervisorOrAdmin` | Lista `contato_opt_out` da empresa com join em `clientes` |

Opt-out automático também ocorre durante o Disparo quando o contato responde com palavra de exclusão (ver `disparoOptOutService.js`).

---

## Como reativar com segurança

1. Definir limites razoáveis nas empresas (ou confiar nos defaults do código).
2. Verificar se `FEATURE_PROTECAO` está configurada conforme desejado.
3. No código, mudar `PROTECAO_DESATIVADA = false` em `services/protecao/protecaoOrchestrator.js`.
4. Monitorar logs; o orquestrador loga bloqueios com prefixo `[protecaoOrchestrator]`.
5. **Risco:** volume checker conta todas mensagens `out` da empresa — inclui atendimento normal. Calibrar limites antes de habilitar.

---

## Onde é chamado

`chatController.js` — antes de cada `provider.sendMessage()`, chama `permitirEnvio({ company_id, conversa_id, cliente_id })`. Com `PROTECAO_DESATIVADA = true`, a chamada retorna `{ allow: true }` sem tocar o banco.

O módulo de Disparo usa seus próprios limites (`disparoLimitesHelper`, `protecao/protecaoOrchestrator.js` com `requireOptIn: true` para validação de opt-in de campanha).
