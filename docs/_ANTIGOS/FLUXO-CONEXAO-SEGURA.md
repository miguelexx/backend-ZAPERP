# Fluxo de Conexão Segura

## Objetivo

Não disparar sync total ao conectar. Iniciar em modo conservador.

## Sequência

1. **Webhook POST /webhooks/zapi/connection** recebe `connected: true`
2. `resetOnConnected(company_id)` — reseta guard de QR
3. Delay 10s para estabilizar instância Z-API
4. `provider.configureWebhooks()` — registra callbacks
5. Consulta `empresas.zapi_auto_sync_contatos`
6. Se `true`: `enqueue(company_id, 'sync_contatos', { reset: true })`
7. Responde 200 imediatamente
8. Worker processa o job em background (lotes, intervalo)

## Status no Frontend

- **ConnectWhatsApp:** Exibe "Sessão conectada / Sincronização pendente" ou "Último sync: ..."
- **Configurações > Clientes:** Toggle "Auto-sync ao conectar" (usa `zapi_auto_sync_contatos`)
- **Configurações > Operacional:** Controles de sync manual, pausar, retomar
