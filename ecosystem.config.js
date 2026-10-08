module.exports = {
  apps: [
    {
      name: 'whatsapp-plataforma-backend',
      script: 'index.js',
      cwd: __dirname,
      // INVARIANTE: NUNCA mudar para cluster/instances>1. As garantias anti-duplicata
      // vivem na memória de UM processo: dedupe de client_temp_id (Map 30s), locks de
      // reenvio (_reenviosEmAndamento), caches TTL (webhook resolver, histórico Whapi,
      // media proxy) e o Socket.IO sem adapter externo. Dois forks = mensagem duplicada
      // no WhatsApp do cliente. Ver docs/ai-handoff/25 (parte 4).
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      time: true,
      env_file: '.env',
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      // Processo opcional extra (a API já embute o worker no index.js).
      // Manter instances: 1. Claim atômico via SKIP LOCKED se os dois rodarem.
      // Envio real continua exigindo LIVE_ENABLED=true e DRY_RUN=false.
      name: 'whatsapp-plataforma-disparo-worker',
      script: 'workers/disparoWorker.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 40,
      min_uptime: '8s',
      restart_delay: 2000,
      exp_backoff_restart_delay: 1000,
      kill_timeout: 35000,
      time: true,
      env_file: '.env',
      env: {
        NODE_ENV: 'production',
        DISPARO_WORKER_ID: 'zaperp-disparo-1',
      },
    },
  ],
}
