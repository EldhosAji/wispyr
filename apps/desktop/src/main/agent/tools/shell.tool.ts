/**
 * Shell Tool — execute shell commands on the user's machine.
 * Uses PowerShell on Windows, bash on Linux/macOS.
 * All commands run scoped to the working folder.
 */
import { registerTool, type ToolContext, type ToolResult } from '../tool-registry'
import { exec } from 'child_process'
import { resolve } from 'path'

// Commands that should NEVER be executed
const BLOCKED_PATTERNS = [
  /\bformat\s+[a-z]:/i,          // format C:
  /\bdel\s+\/s\s+\/q\s+[a-z]:\\/i, // del /s /q C:\
  /\brm\s+-rf\s+\//,              // rm -rf /
  /\bshutdown\b/i,                // shutdown
  /\brestart\b.*\bcomputer\b/i,   // restart computer
  /\breg\s+(delete|add)\b/i,      // registry modification
  /\bnet\s+user\b/i,              // user account modification
  /\bmklink\b/i,                  // symlink creation
  /\bschtasks\b.*\/create/i,      // scheduled task creation
  /\bwmic\b.*\bdelete\b/i,        // WMI deletion
]

function isCommandBlocked(command: string): string | null {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return `Blocked: command matches dangerous pattern "${pattern.source}"`
    }
  }
  return null
}

export function registerShellTool(): void {
  registerTool({
    name: 'run_command',
    description: 'Execute a shell command in the working folder. Returns stdout, stderr, and exit code.',
    parameters: [
      { name: 'command', type: 'string', description: 'Shell command to execute', required: true },
      { name: 'timeout', type: 'number', description: 'Timeout in seconds (default 30, max 120)', required: false },
    ],
    permissionLevel: 'destructive',
    concurrencySafe: false,
    async execute(params: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
      const command = params.command || ''
      const timeoutSec = Math.min(params.timeout || 30, 120)

      if (!command.trim()) {
        return { success: false, log: 'No command provided', result: '', error: 'Empty command' }
      }

      const blocked = isCommandBlocked(command)
      if (blocked) {
        return { success: false, log: blocked, result: '', error: blocked }
      }

      const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash'
      const cwd = resolve(ctx.folder)

      return new Promise((resolveResult) => {
        exec(command, {
          cwd,
          shell,
          timeout: timeoutSec * 1000,
          maxBuffer: 1024 * 1024, // 1MB
          env: { ...process.env, WISPYR: '1' },
        }, (error, stdout, stderr) => {
          const exitCode = error?.code ?? 0
          const truncatedStdout = stdout.length > 50000 ? stdout.substring(0, 50000) + '\n...(truncated)' : stdout
          const truncatedStderr = stderr.length > 10000 ? stderr.substring(0, 10000) + '\n...(truncated)' : stderr

          const log = [
            `$ ${command}`,
            `Exit code: ${exitCode}`,
            truncatedStdout ? `\n── stdout ──\n${truncatedStdout}` : '',
            truncatedStderr ? `\n── stderr ──\n${truncatedStderr}` : '',
          ].filter(Boolean).join('\n')

          if (error && error.killed) {
            resolveResult({ success: false, log, result: '', error: `Command timed out after ${timeoutSec}s` })
          } else if (exitCode !== 0) {
            resolveResult({ success: false, log, result: truncatedStderr || `Exit code ${exitCode}`, error: truncatedStderr || `Exit code ${exitCode}` })
          } else {
            resolveResult({ success: true, log, result: truncatedStdout.substring(0, 500) || 'Done' })
          }
        })
      })
    },
  })
}
