/**
 * Scheduler — cron-like recurring task execution.
 * Checks every 60 seconds if any scheduled task is due.
 * Tasks are persisted via electron-store.
 */
import Store from 'electron-store'
import { runAgent } from './engine'
import * as providersStore from '../store/providers.store'

// ─── Types ───

export interface ScheduledTask {
  id: string
  name: string
  prompt: string
  schedule: string     // cron expression or interval string
  folder: string
  enabled: boolean
  createdAt: string
  lastRun?: string
  nextRun?: string
  intervalMs?: number  // parsed interval in ms
}

// ─── Store ───

interface ScheduleSchema {
  tasks: ScheduledTask[]
}

let _store: Store<ScheduleSchema> | null = null
function store(): Store<ScheduleSchema> {
  if (!_store) {
    _store = new Store<ScheduleSchema>({
      name: 'scheduled-tasks',
      defaults: { tasks: [] },
    })
  }
  return _store
}

// ─── CRUD ───

export function addScheduledTask(opts: { prompt: string; schedule: string; name: string; folder: string }): ScheduledTask {
  const intervalMs = parseSchedule(opts.schedule)
  const task: ScheduledTask = {
    id: `sched_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name: opts.name,
    prompt: opts.prompt,
    schedule: opts.schedule,
    folder: opts.folder,
    enabled: true,
    createdAt: new Date().toISOString(),
    nextRun: intervalMs ? new Date(Date.now() + intervalMs).toISOString() : undefined,
    intervalMs,
  }

  const tasks = store().get('tasks')
  tasks.push(task)
  store().set('tasks', tasks)
  console.log(`[Scheduler] Added task: ${task.name} (${task.schedule})`)
  return task
}

export function removeScheduledTask(nameOrId: string): boolean {
  const tasks = store().get('tasks')
  const filtered = tasks.filter(t => t.id !== nameOrId && t.name !== nameOrId)
  if (filtered.length === tasks.length) return false
  store().set('tasks', filtered)
  return true
}

export function getScheduledTasks(): ScheduledTask[] {
  return store().get('tasks')
}

export function toggleScheduledTask(id: string, enabled: boolean): boolean {
  const tasks = store().get('tasks')
  const task = tasks.find(t => t.id === id)
  if (!task) return false
  task.enabled = enabled
  store().set('tasks', tasks)
  return true
}

// ─── Scheduler Loop ───

let _intervalHandle: ReturnType<typeof setInterval> | null = null

export function startScheduler(): void {
  if (_intervalHandle) return
  console.log('[Scheduler] Started — checking every 60s')
  _intervalHandle = setInterval(checkDueTasks, 60_000)
}

export function stopScheduler(): void {
  if (_intervalHandle) {
    clearInterval(_intervalHandle)
    _intervalHandle = null
  }
}

async function checkDueTasks(): Promise<void> {
  const tasks = store().get('tasks')
  const now = Date.now()

  for (const task of tasks) {
    if (!task.enabled || !task.nextRun) continue
    if (new Date(task.nextRun).getTime() > now) continue

    console.log(`[Scheduler] Running due task: ${task.name}`)
    const provider = providersStore.getActiveProvider()
    if (!provider) continue

    // Update lastRun and nextRun
    task.lastRun = new Date().toISOString()
    task.nextRun = task.intervalMs ? new Date(now + task.intervalMs).toISOString() : undefined
    store().set('tasks', tasks)

    // Execute (fire and forget — don't block the checker)
    const taskId = `sched_exec_${Date.now()}`
    runAgent({
      taskId,
      folder: task.folder,
      provider,
      message: task.prompt,
      maxTurns: 10,
      stream: false,
      onEvent: (event) => {
        if (event.type === 'error') console.log(`[Scheduler] Task "${task.name}" error: ${event.error}`)
        if (event.type === 'task_complete') console.log(`[Scheduler] Task "${task.name}" completed`)
      },
      onPermission: async () => true, // Scheduled tasks auto-approve read-only, skip write
    }).catch(err => console.log(`[Scheduler] Task "${task.name}" failed: ${err.message}`))
  }
}

// ─── Schedule Parser ───

function parseSchedule(schedule: string): number | undefined {
  const lower = schedule.toLowerCase().trim()

  // Simple intervals
  const intervalMatch = lower.match(/^every\s+(\d+)\s*(s|sec|m|min|h|hr|hour|d|day)s?$/)
  if (intervalMatch) {
    const val = parseInt(intervalMatch[1])
    const unit = intervalMatch[2]
    if (unit.startsWith('s')) return val * 1000
    if (unit.startsWith('m')) return val * 60_000
    if (unit.startsWith('h')) return val * 3600_000
    if (unit.startsWith('d')) return val * 86400_000
  }

  // Named intervals
  if (lower === 'hourly') return 3600_000
  if (lower === 'daily') return 86400_000
  if (lower === 'weekly') return 604800_000

  // TODO: full cron expression parser
  // For now, treat unknown formats as daily
  console.log(`[Scheduler] Unknown schedule format "${schedule}", defaulting to daily`)
  return 86400_000
}
