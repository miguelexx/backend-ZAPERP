module.exports = {
  apps: [
    {
      name: 'zap-erp-backend',
      script: 'index.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      time: true,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
}

