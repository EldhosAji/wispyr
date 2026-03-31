// Launch electron-vite dev with ELECTRON_RUN_AS_NODE unset.
// VS Code / Claude Code terminals set ELECTRON_RUN_AS_NODE=1 which causes
// Electron to run as plain Node.js instead of as an Electron app.
const { spawn } = require('child_process')
const path = require('path')

// Remove the env var that breaks Electron
delete process.env.ELECTRON_RUN_AS_NODE

const appDir = path.resolve(__dirname, '..')

const child = spawn('npx', ['electron-vite', 'dev'], {
  stdio: 'inherit',
  env: process.env,
  cwd: appDir,
  shell: true,
})

child.on('close', (code) => {
  process.exit(code || 0)
})
