# Configuração e ambientes

> Análise estática: 2026-08-23 · `master` · `66e0771d9f61f840524cd4b0645e742df374a77a` · fontes: `package.json`, `.env.example` (somente nomes), `index.js`, `ecosystem.config.js` e referências `process.env` no backend.

## Pré-requisitos e scripts

Node.js/npm e acesso às dependências configuradas. Versão exata obrigatória do Node não foi fixada em `engines`: **NÃO CONFIRMADO**. Instalação reproduzível: `npm ci`. Scripts confirmados: `npm run dev` (nodemon), `npm start` (servidor), `npm run worker:disparo` (worker separado opcional; a fila já roda no HTTP) e `npm test` (Jest em série). Não há script de build.

`index.js` exige no boot `JWT_SECRET`, `APP_URL`, `WHATSAPP_WEBHOOK_TOKEN` e `NODE_ENV`. Supabase é necessário à operação normal. Porta vem de `PORT`. Em testes, definir `ZAPERP_DISABLE_BACKGROUND_JOBS=1` e manter Disparo em dry-run/desligado.

## Variáveis por finalidade

Somente nomes/finalidades; valores devem vir do cofre/ambiente.

| Grupo | Nomes observados |
|---|---|
| Processo/URLs | `NODE_ENV`, `PORT`, `APP_URL`, `CORS_ORIGINS`, `TRUST_PROXY`, `ZAPERP_DISABLE_BACKGROUND_JOBS` |
| JWT/cron/webhook | `JWT_SECRET`, `JWT_EXPIRES_IN`, `CRON_SECRET`, `WHATSAPP_WEBHOOK_TOKEN`, `ALLOW_INSTANCEID_WEBHOOK_FALLBACK`, `WEBHOOK_LOG_FULL_PAYLOAD` |
| Supabase | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_TIMEOUT_MS` |
| UltraMSG/default legado | `ULTRAMSG_INSTANCE_ID`, `ULTRAMSG_TOKEN`, `ULTRAMSG_BASE_URL` e opções de timeout/retry referenciadas pelo provider |
| Limites | `LOGIN_RATE_LIMIT_MAX`, `WEBHOOK_RATE_LIMIT_MAX`, `API_RATE_LIMIT_MAX`, `DESTRUCTIVE_RATE_LIMIT_MAX`, `AI_RATE_LIMIT_MAX` |
| Upload/proxy | `UPLOADS_DIR`, limites de arquivo/vídeo, `MEDIA_PROXY_EXTRA_HOSTS`, limites/timeout do proxy |
| R2 | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_ENDPOINT`, flags/allowlist de rollout, mirror, retenção e migration-on-boot |
| Socket/log | `SOCKET_DEBUG`, flags/níveis de log e detalhes de request/webhook referenciados |
| Push | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, credenciais/config Firebase/FCM referenciadas |
| OpenAI | `OPENAI_API_KEY`, modelo, limites/cota/cache/timeout referenciados pelo módulo AI |
| Produtos | flags do sync, intervalos, credenciais/host/porta/database PostgreSQL de produtos e SQL Server WM |
| CRM/help desk | `CRM_AVANCADO_URL`, `ZAP_SSO_SECRET`, token/CNPJ/company do help desk e URLs de integração |
| Disparo | `DISPARO_EMBEDDED_WORKER`, `DISPARO_WORKER_ENABLED`, `DISPARO_LIVE_ENABLED`, `DISPARO_DRY_RUN`, `DISPARO_TEST_ALLOWLIST`, `DISPARO_WORKER_POLL_MS`, `DISPARO_WORKER_LEASE_SECONDS`, `DISPARO_WORKER_BATCH_SIZE`, heartbeat/backoff/limites referenciados |
| Jobs/chatbot | intervalos/flags dos schedulers, timeouts de inatividade, alertas, triagem e regras automáticas |

Para o nome exato antes de configurar, cruzar `.env.example` com `rg "process\.env"`; nem toda variável no exemplo está ativa e algumas referências possuem default. O `.env.example` existente contém exemplo com aparência de credencial e não é considerado padrão seguro; não foi criado outro nem copiado valor.

> **Nota sobre vars `META_*` / `WHATSAPP_TOKEN` no `.env.example`:** As variáveis `WHATSAPP_TOKEN`, `META_ACCESS_TOKEN`, `META_APP_SECRET`, `PHONE_NUMBER_ID`, `WHATSAPP_PHONE_ID` e `WEBHOOK_VERIFY_TOKEN` aparecem comentadas no `.env.example`. Pertencem à **Meta Cloud API (provider removido)**. O sistema **não usa Meta Cloud API** — o único provider ativo é UltraMSG. Essas vars estão no exemplo por legado histórico e podem ser ignoradas completamente. Não implementar nenhuma lógica com base nelas.

## Desenvolvimento e produção

Desenvolvimento usa nodemon e normalmente `.env` local ignorado. Produção confirmada no repositório: PM2 via `ecosystem.config.js`, modo `fork`, `instances: 1`, autorestart e `NODE_ENV=production`. Não há Dockerfile, Compose ou workflow CI/CD no backend. TLS/reverse proxy, diretório da VPS, usuário do processo, agendador externo, backup e sequência real de deploy são **NÃO CONFIRMADOS**.

Supabase/PostgreSQL é o banco de domínio; service role deve ficar apenas no servidor. Produtos também podem usar PostgreSQL separado e SQL Server. UltraMSG, R2, OpenAI, FCM/Web Push, CRM e help desk são condicionais à configuração.

## Mídia e portas

HTTP/Socket.IO compartilham `PORT`. Upload local usa filesystem do processo; R2 é opcional por rollout. Em mais de um host, disco local não é compartilhado. O backend também contém lógica para servir artefato estático, mas nenhum frontend foi analisado nesta auditoria.

## Versão implantada

`GET /health` retorna apenas disponibilidade e `/health/detailed` testa Supabase; não existe `build_sha`, commit ou versão de pacote exposta. Para verificar a VPS hoje seria necessário comparar o commit/artefato/processo por acesso operacional autorizado: **PENDENTE DE VALIDAÇÃO**. Direção recomendada futura: injetar identificador imutável no deploy e mostrá-lo em health/log de boot, sem segredo.

## Manifesto exaustivo de nomes de ambiente

Inventário mecânico das referências `process.env` em JavaScript do backend (excluindo testes, dependências e o artefato Python) mais nomes exclusivos do `.env.example`. A presença aqui **não** significa que a integração esteja ativa. Variáveis de scripts operacionais não são pré-requisitos do servidor. Não há valores neste inventário.

| Finalidade | Nomes |
|---|---|
| Processo, HTTP, CORS e socket | `APP_URL`, `AUTO_REFRESH_MINUTES`, `BASE_URL`, `CORS_ORIGINS`, `HIDE_WHATSAPP_DISCONNECT_BANNER`, `NODE_ENV`, `PORT`, `SHUTDOWN_TIMEOUT_MS`, `SOCKET_DEBUG`, `TRUST_PROXY`, `ZAPERP_CORS_EXTRA_ORIGINS` |
| Segurança, identidade, webhook, cron e e-mail | `ADMIN_ATENDIMENTO_ALERTA_DEBUG`, `ADMIN_ATENDIMENTO_ALERTA_INTERVAL_MINUTES`, `ADMIN_EMAIL`, `ADMIN_NOME`, `ADMIN_SENHA`, `CRON_SECRET`, `JWT_EXPIRES_IN`, `JWT_SECRET`, `SMTP_HOST`, `SMTP_URL`, `WEBHOOK_INSTANCE_DUPLICATE_STRATEGY`, `WEBHOOK_LOG_FULL_PAYLOAD`, `WEBHOOK_TOKEN` |
| Supabase | `SUPABASE_KEY`, `SUPABASE_SERVICE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_TIMEOUT_MS`, `SUPABASE_URL` |
| WhatsApp/UltraMSG e sincronização | `OLD_MESSAGES_SYNC_DEBUG`, `OLD_MESSAGES_SYNC_DELAY_MS`, `OLD_MESSAGES_SYNC_MAX_CHATS`, `OLD_MESSAGES_SYNC_MAX_PAGES`, `OLD_MESSAGES_SYNC_MESSAGES_PER_CHAT`, `SYNC_BATCH_SIZE`, `SYNC_INTERVAL_BETWEEN_BATCHES_MS`, `SYNC_MAX_PAGES_PER_RUN`, `ULTRAMSG_BASE_URL`, `ULTRAMSG_INSTANCE_ID`, `ULTRAMSG_SEND_DELAY`, `ULTRAMSG_SEND_DELAY_MAX`, `ULTRAMSG_SEND_DELAY_MS`, `ULTRAMSG_TIMEOUT_MS`, `ULTRAMSG_TOKEN`, `ULTRAMSG_WEBHOOK_DOWNLOAD_MEDIA`, `ULTRAMSG_WEBHOOK_RETRIES`, `WHATSAPP_DEBUG`, `WHATSAPP_SEND_GUARD_DEBUG`, `WHATSAPP_SEND_GUARD_HASH_SALT`, `WHATSAPP_SEND_GUARD_MODE`, `WHATSAPP_WEBHOOK_TOKEN`, `ZAPI_CONNECTED_PHONE`, `ZAPI_INSTANCE_ID` |
| Disparo | `DISPARO_AUDIO_MAX_MB`, `DISPARO_DOC_MAX_MB`, `DISPARO_EMBEDDED_WORKER`, `DISPARO_IMAGEM_MAX_MB`, `DISPARO_INTERVALO_MIN_PROVEDOR_SEC`, `DISPARO_LIMITE_DIA_PROVEDOR`, `DISPARO_LIMITE_HORA_PROVEDOR`, `DISPARO_MIDIA_MAX_CONCURRENT`, `DISPARO_TEST_ALLOWLIST`, `DISPARO_UPLOAD_MAX_MB`, `DISPARO_VIDEO_MAX_MB`, `DISPARO_WORKER_ID` |
| Mídia, upload e R2 | `INBOUND_MEDIA_BACKFILL_DISABLED`, `INBOUND_MEDIA_DUE_BATCH`, `INBOUND_MEDIA_DUE_INTERVAL_MS`, `INBOUND_MEDIA_FETCH_TIMEOUT_MS`, `INBOUND_MEDIA_RETRY_BATCH`, `INBOUND_MEDIA_RETRY_DISABLED`, `INBOUND_MEDIA_RETRY_INTERVAL_MS`, `INBOUND_MEDIA_RETRY_MAX_AGE_HOURS`, `MEDIA_PROXY_EXTRA_HOSTS`, `MEDIA_PROXY_TIMEOUT_MS`, `MEDIA_RETENTION_BATCH`, `R2_CLEANUP_BATCH`, `R2_HTTP_TIMEOUT_MS`, `R2_MIGRATE_BATCH`, `R2_MIGRATE_HISTORICO_ON_BOOT`, `R2_MIRROR_BATCH`, `R2_MIRROR_DISABLED`, `R2_MIRROR_INTERVAL_MS`, `UPLOADS_DIR` |
| Push | `FIREBASE_SERVICE_ACCOUNT_JSON`, `FIREBASE_SERVICE_ACCOUNT_PATH`, `VAPID_PRIVATE_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`, `WEB_PUSH_DEBUG`, `WEB_PUSH_MAX_MESSAGE_AGE_MS`, `WEB_PUSH_TTL_SECONDS` |
| Produtos e WM | `PRODUTOS_DB_CONNECTION_TIMEOUT_MS`, `PRODUTOS_DB_HOST`, `PRODUTOS_DB_IDLE_TIMEOUT_MS`, `PRODUTOS_DB_NAME`, `PRODUTOS_DB_PASSWORD`, `PRODUTOS_DB_POOL_MAX`, `PRODUTOS_DB_PORT`, `PRODUTOS_DB_SSL`, `PRODUTOS_DB_USER`, `PRODUTOS_SYNC_BATCH_SIZE`, `PRODUTOS_SYNC_ENABLED`, `PRODUTOS_SYNC_INTERNAL_ENABLED`, `PRODUTOS_SYNC_INTERVAL_MINUTES`, `WM_PRODUTOS_COMPANY_ID`, `WM_SQLSERVER_CONNECTION_TIMEOUT_MS`, `WM_SQLSERVER_DATABASE`, `WM_SQLSERVER_HOST`, `WM_SQLSERVER_IDLE_TIMEOUT_MS`, `WM_SQLSERVER_PASSWORD`, `WM_SQLSERVER_POOL_MAX`, `WM_SQLSERVER_PORT`, `WM_SQLSERVER_REQUEST_TIMEOUT_MS`, `WM_SQLSERVER_USER` |
| IA, CRM e help desk | `AI_MODEL`, `AI_MONTHLY_DEFAULT_LIMIT`, `AI_PROMPT_MAX_CHARS`, `CRM_AVANCADO_URL`, `HELPDESK_INTEGRATION_COMPANY_ID`, `HELPDESK_INTEGRATION_TOKEN`, `OPENAI_API_KEY`, `ZAP_SSO_SECRET` |
| Filas, chatbot, atendimento e buscas | `ABSENCE_FINALIZATION_EMERGENCY_DISABLED`, `ABSENCE_FINALIZATION_INTERVAL_MINUTES`, `ABSENCE_FINALIZATION_LOTE_MAX`, `ABSENCE_FINALIZATION_MAX_PER_CYCLE`, `ABSENCE_FINALIZATION_SCAN_LIMIT`, `ATENDIMENTO_SEM_RESPOSTA_INTERVAL_MINUTES`, `CHATBOT_WELCOME_MAX_INBOUND_AGE_MINUTES`, `CHAT_FILTER_ID_LIMIT`, `CHAT_LIST_SEM_CONVERSA_LIMIT`, `CHAT_SEARCH_ID_LIMIT`, `CHAT_SEARCH_INCLUDE_MESSAGE_TEXT`, `CHAT_SEARCH_LIST_FETCH_CAP`, `CHAT_SEARCH_MESSAGES_PAGE_SIZE`, `CHAT_SEARCH_MSG_TIER_LIMIT`, `CHAT_SEARCH_SCAN_LIMIT`, `OPERATIONAL_SAFE_MODE_DEFAULT`, `PENDING_OUTBOUND_RECONCILE_ENABLED`, `PENDING_OUTBOUND_RECONCILE_INTERVAL_MINUTES`, `PENDING_OUTBOUND_RESEND_ENABLED`, `QUEUE_BACKOFF_BASE_MS`, `QUEUE_MAX_CONCURRENT_JOBS`, `QUEUE_MAX_RETRIES`, `QUEUE_STALE_JOB_TIMEOUT_MS`, `SEND_MESSAGE_CHAT_ID`, `SEND_MESSAGE_TEXT`, `TRIAGE_REDIRECT_EMERGENCY_DISABLED`, `TRIAGE_REDIRECT_INTERVAL_MINUTES`, `TRIAGE_REDIRECT_MAX_PER_CYCLE` |
| Scripts operacionais/certificação | `CHAT_ID`, `COMPANY_COUNT`, `COMPANY_ID`, `CONCURRENCY`, `DURATION_SECONDS`, `INSTANCE_ID`, `JEST_WORKER_ID`, `JWT_TOKEN`, `MAIL_HOST`, `USERS_PER_COMPANY` |
| Acesso indireto por helpers | `AI_RATE_LIMIT_MAX`, `API_RATE_LIMIT_MAX`, `DESTRUCTIVE_RATE_LIMIT_MAX`, `DISPARO_BACKOFF_BASE_SEC`, `DISPARO_BACKOFF_MAX_SEC`, `DISPARO_MAX_TENTATIVAS`, `DISPARO_SEND_TIMEOUT_MS`, `DISPARO_WORKER_BATCH_SIZE`, `DISPARO_WORKER_LEASE_SECONDS`, `DISPARO_WORKER_POLL_MS`, `INBOUND_MEDIA_BACKFILL_DEBOUNCE_MS`, `INBOUND_MEDIA_BACKFILL_MAX_CONCURRENT`, `INBOUND_MEDIA_BACKFILL_TRAILING_MS`, `LOGIN_RATE_LIMIT_MAX`, `MEDIA_RETENTION_DAYS`, `MEDIA_RETENTION_INTERVAL_HOURS`, `PENDING_OUTBOUND_RECONCILE_BATCH_LIMIT`, `PENDING_OUTBOUND_RECONCILE_DEFER_MS`, `PENDING_OUTBOUND_RECONCILE_FAIL_AFTER_MINUTES`, `PENDING_OUTBOUND_RECONCILE_GRACE_MINUTES`, `PENDING_OUTBOUND_RECONCILE_LOOKBACK_HOURS`, `PENDING_OUTBOUND_RESEND_WINDOW_MINUTES`, `R2_ALL_COMPANIES`, `R2_COMPANY_IDS`, `R2_KEEP_LOCAL`, `R2_LOCAL_CLEANUP_DELAY_MINUTES`, `R2_PRESIGN_EXPIRES_SECONDS`, `WEB_PUSH_FCM_ALONGSIDE_VAPID`, `WEBHOOK_RATE_LIMIT_MAX`, `WHATSAPP_SEND_GUARD_AUTOMATION_INTERVAL_MS`, `WHATSAPP_SEND_GUARD_HUMAN_INTERVAL_MS`, `WM_SQLSERVER_ENCRYPT`, `WM_SQLSERVER_TRUST_CERT` |
