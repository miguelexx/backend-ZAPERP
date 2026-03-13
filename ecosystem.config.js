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
  ],
}

