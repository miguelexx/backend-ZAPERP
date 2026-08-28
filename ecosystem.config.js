module.exports = {
  apps: [
    {
      name: 'whatsapp-plataforma-backend',
      script: 'index.js',
      cwd: __dirname,
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
      // Processo independente da API HTTP. Claim atômico via SKIP LOCKED.
      // Manter instances: 1. DISPARO_WORKER_ENABLED=true no .env para processar a fila.
      // Envio real continua exigindo também LIVE_ENABLED=true e DRY_RUN=false.
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
