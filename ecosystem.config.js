module.exports = {
  apps: [
    {
      name: 'zaperpapi',
      script: 'index.js',
      cwd: __dirname,
      env_file: '.env',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
}

