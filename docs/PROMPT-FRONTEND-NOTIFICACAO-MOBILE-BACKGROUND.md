## Prompt Frontend — Notificação Mobile em background/offline

Implemente no frontend (PWA) o fluxo de Web Push para garantir notificação de nova mensagem do contato ao atendente, inclusive quando o app estiver em segundo plano ou o usuário estiver usando outro app.

### Objetivo funcional
- Quando chegar `nova_mensagem` inbound de contato, o atendente deve receber notificação push no celular.
- A notificação deve funcionar com app em background/tela bloqueada.
- Se o celular estiver offline/desligado, a notificação deve chegar quando reconectar (respeitando TTL do push configurado no backend).

### Requisitos técnicos
1. Registrar `service worker` no app (`/service-worker.js`) em produção.
2. Solicitar permissão de notificação para usuário autenticado e salvar o estado.
3. Buscar chave pública VAPID em `GET /users/push/vapid-public-key`.
4. Criar assinatura `PushSubscription` e enviar para backend:
   - `POST /users/me/push/subscribe` com `{ endpoint, keys: { p256dh, auth } }`.
5. Remover assinatura ao logout/desativação:
   - `DELETE /users/me/push/subscribe`.
6. Garantir re-subscribe automático quando:
   - token expirar,
   - `pushsubscriptionchange`,
   - troca de dispositivo/navegador,
   - assinatura inválida.
7. No `service worker`:
   - Tratar evento `push` e exibir `showNotification`.
   - Tratar `notificationclick` e focar/abrir rota `data.openUrl`.
   - Definir `requireInteraction` em mobile quando necessário para maior visibilidade.
8. Evitar notificação duplicada:
   - usar `tag` recebida no payload,
   - não disparar notificação local adicional se já houver push.
9. UI de diagnóstico:
   - exibir status: `suportado`, `permissao`, `assinado`, `última sincronização`.
   - botão “Reativar notificações”.

### Critérios de aceite (teste manual)
1. Com app aberto, receber mensagem de contato e notificação aparecer.
2. Com app em background e usuário em outro app, notificação aparecer.
3. Com tela bloqueada, notificação aparecer.
4. Com celular desligado por alguns minutos e religado, notificação pendente ser entregue.
5. Clicar na notificação abrir/focar conversa correta.
6. Logout remove assinatura e não recebe mais push.

### Observações importantes
- Backend já possui endpoints de subscribe/unsubscribe e disparo para inbound.
- Backend usa TTL configurável por `WEB_PUSH_TTL_SECONDS` (padrão 7 dias), então entrega após reconexão depende do service worker e assinatura válidos no frontend.
