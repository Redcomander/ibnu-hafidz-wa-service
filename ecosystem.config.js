module.exports = {
  apps: [
    {
      name: 'wa-service',
      script: 'server.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1200M',
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
        WA_SERVICE_TOKEN: 'change-me',
        WA_SESSION_DIR: '.wwebjs',
        WA_BROWSER_PATH: '/usr/bin/chromium',
        WA_QR_TTL_MS: 300000,
      },
    },
  ],
};
