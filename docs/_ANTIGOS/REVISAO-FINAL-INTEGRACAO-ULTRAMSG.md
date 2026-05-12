# Revisão Final — Integração UltraMSG e Proteção contra Bloqueio

Documento de verificação e melhorias aplicadas (16/03/2025).

## ✅ Verificações realizadas

### 1. Integração UltraMSG
- **Webhook**: `webhookUltramsgController` → `webhookZapiController.receberZapi` — fluxo correto
- **Mensagem de finalização**: `encerrarChat` usa `getProvider().sendText()` com `companyId` e `conversaId`
- **Regras e opt-out**: `sendMessage` callback passa `companyId` para o provider
- **Chatbot**: `sendWithThrottle` com `intervaloEnvioSegundos` + provider `awaitSendDelay`

### 2. Proteção contra bloqueio WhatsApp
| Camada | Variável/Config | Descrição |
|--------|-----------------|-----------|
| Provider global | `ULTRAMSG_SEND_DELAY_MS` | Delay entre **todos** os envios (mensagem finalização, regras, opt-out, chatbot) |
| Chatbot por empresa | `intervaloEnvioSegundos` (ia_config) | Throttle adicional só para mensagens do chatbot (0–60s, padrão 3s) |

**Recomendação**: configure `ULTRAMSG_SEND_DELAY_MS=1000` no `.env` para 1 segundo mínimo entre envios.

### 3. Correções aplicadas

#### webhookZapiController
- **Bug**: conversa era reaberta mesmo quando o cliente enviava nota de avaliação (0–10)
- **Correção**: reabrir apenas quando a mensagem NÃO for uma nota válida (`!avalResult.registered`)

#### chatController (encerrarChat)
- **Mensagem finalização**: agora emite `nova_mensagem` via Socket.IO para o frontend exibir em tempo real
- Usa `enrichMensagemComAutorUsuario` e `emitirEventoEmpresaConversa` como nos outros fluxos de envio

#### avaliacaoService
- Tratamento de erro `42P01` (tabela inexistente) para instalações antigas sem migração

#### aiDashboardService
- `qNotasAtendimentoStats` com try/catch para tabela inexistente
- Indentação corrigida dentro do bloco try

#### .env.example
- Comentário atualizado para `ULTRAMSG_SEND_DELAY_MS` com recomendação de 1000ms

## Checklist de deploy

1. [ ] Executar `RUN_IN_SUPABASE.sql` ou migrações (inclui `avaliacoes_atendimento` e `atendente_id`)
2. [ ] Em bases antigas: executar `FIX_avaliacoes_atendente_id.sql` se necessário
3. [ ] Configurar `ULTRAMSG_SEND_DELAY_MS=1000` no `.env` (recomendado)
4. [ ] Configurar `intervaloEnvioSegundos` na tela do chatbot (frontend)
5. [ ] Configurar `enviarMensagemFinalizacao` e `mensagemFinalizacao` na tela do chatbot

## Testes

- **13 testes** passando (auth, health, configOperacional)
- Fluxos críticos: encerrarChat, webhook receberZapi, avaliacaoService, chatbotTriageService
