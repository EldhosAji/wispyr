/**
 * Hook System — pre/post hooks on tool operations.
 *
 * Hooks intercept tool execution for logging, validation, or side effects.
 * Configured via settings and can run shell commands or custom logic.
 */
import Store from 'electron-store'
import { exec } from 'child_process'

// ─── Types ───

export interface HookDefinition {
  id: string
  name: string
  event: string          // tool name (e.g. "write_file") or "*" for all
  timing: 'pre' | 'post'
  action: string         // shell command to execute
  enabled: boolean
  /** For pre hooks: if true, hook failure blocks the tool */
  blocking?: boolean
}

export interface HookResult {
  allowed: boolean
  output?: string
  error?: string
}

// ─── Store ───

interface HooksSchema {
  hooks: HookDefinition[]
}

let _store: Store<HooksSchema> | null = null
function hookStore(): Store<HooksSchema> {
  if (!_store) {
    _store = new Store<HooksSchema>({ name: 'hooks', defaults: { hooks: [] } })
  }
  return _store
}

// ─── CRUD ───

export function getHooks(): HookDefinition[] {
  return hookStore().get('hooks')
}

export function addHook(hook: Omit<HookDefinition, 'id'>): HookDefinition {
  const hooks = hookStore().get('hooks')
  const newHook: HookDefinition = {
    ...hook,
    id: `hook_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
  }
  hooks.push(newHook)
  hookStore().set('hooks', hooks)
  return newHook
}

export function removeHook(id: string): boolean {
  const hooks = hookStore().get('hooks')
  const filtered = hooks.filter(h => h.id !== id)
  if (filtered.length === hooks.length) return false
  hookStore().set('hooks', filtered)
  return true
}

export function toggleHook(id: string, enabled: boolean): boolean {
  const hooks = hookStore().get('hooks')
  const hook = hooks.find(h => h.id === id)
  if (!hook) return false
  hook.enabled = enabled
  hookStore().set('hooks', hooks)
  return true
}

// ─── Execution ───

/**
 * Run pre-hooks for a tool. Returns { allowed: true } if all pass.
 * If any blocking pre-hook fails, returns { allowed: false, error: ... }.
 */
export async function runPreHooks(
  toolName: string,
  params: Record<string, any>,
  folder: string,
): Promise<HookResult> {
  const hooks = getHooks().filter(h =>
    h.enabled && h.timing === 'pre' && (h.event === '*' || h.event === toolName)
  )

  for (const hook of hooks) {
    try {
      const output = await executeHookCommand(hook.action, folder, {
        WISPYR_TOOL: toolName,
        WISPYR_PARAMS: JSON.stringify(params),
        WISPYR_HOOK: hook.name,
      })

      if (hook.blocking && output.exitCode !== 0) {
        console.log(`[Hooks] Pre-hook "${hook.name}" blocked ${toolName}: ${output.stderr}`)
        return { allowed: false, output: output.stdout, error: output.stderr || `Hook "${hook.name}" blocked this action` }
      }
    } catch (err: any) {
      if (hook.blocking) {
        return { allowed: false, error: `Hook "${hook.name}" error: ${err.message}` }
      }
    }
  }

  return { allowed: true }
}

/**
 * Run post-hooks for a tool. Always non-blocking (fire and forget).
 */
export async function runPostHooks(
  toolName: string,
  params: Record<string, any>,
  result: any,
  folder: string,
): Promise<void> {
  const hooks = getHooks().filter(h =>
    h.enabled && h.timing === 'post' && (h.event === '*' || h.event === toolName)
  )

  for (const hook of hooks) {
    try {
      await executeHookCommand(hook.action, folder, {
        WISPYR_TOOL: toolName,
        WISPYR_PARAMS: JSON.stringify(params),
        WISPYR_RESULT: JSON.stringify(result).substring(0, 5000),
        WISPYR_HOOK: hook.name,
      })
    } catch (err: any) {
      console.log(`[Hooks] Post-hook "${hook.name}" error: ${err.message}`)
    }
  }
}

// ─── Helper ───

function executeHookCommand(
  command: string,
  cwd: string,
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    exec(command, {
      cwd,
      timeout: 10000,
      env: { ...process.env, ...env },
    }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        exitCode: error?.code ?? 0,
      })
    })
  })
}
