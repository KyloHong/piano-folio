module.exports = {
  apps: [{
    name: 'piano-folio',
    script: 'server.js',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    instances: 1,
    autorestart: true,
    max_memory_restart: '500M',
    error_file: '/var/log/piano-folio/error.log',
    out_file: '/var/log/piano-folio/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true
  }]
};
