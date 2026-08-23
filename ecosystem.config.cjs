module.exports = {
  apps: [{
    name: 'jerrybot',
    script: 'src/index.js',
    cwd: __dirname,
    instances: 1,
    exec_mode: 'fork',
    max_memory_restart: '900M',
    kill_timeout: 8000, // give the SIGINT flush (Task 3) time to run
    env: { NODE_ENV: 'production' },
  }, {
    name: 'hitlijn',
    script: 'hitlijn/server.mjs',
    cwd: __dirname,
    max_memory_restart: '250M',
  }],
};
