/**
 * Schedule Tool — create, list, and manage recurring scheduled tasks.
 * Tasks run on cron-like intervals and execute via the agent engine.
 */
import { registerTool, type ToolContext, type ToolResult } from '../tool-registry'
import {
  addScheduledTask, removeScheduledTask, getScheduledTasks,
  toggleScheduledTask, type ScheduledTask,
} from '../scheduler'

export function registerScheduleTools(): void {
  registerTool({
    name: 'schedule_task',
    description: 'Schedule a recurring task. Supports cron expressions or simple intervals like "every 5m", "every 1h", "daily", "hourly".',
    parameters: [
      { name: 'prompt', type: 'string', description: 'Task description to run each time', required: true },
      { name: 'schedule', type: 'string', description: 'Cron expression or interval (e.g. "every 30m", "daily", "0 9 * * *")', required: true },
      { name: 'name', type: 'string', description: 'Name for this scheduled task', required: false },
    ],
    permissionLevel: 'write',
    concurrencySafe: true,
    async execute(params: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
      const task = addScheduledTask({
        prompt: params.prompt,
        schedule: params.schedule,
        name: params.name || params.prompt.substring(0, 50),
        folder: ctx.folder,
      })

      return {
        success: true,
        log: `Scheduled task "${task.name}" (${task.schedule})\nID: ${task.id}\nNext run: ${task.nextRun || 'calculating...'}`,
        result: `Task scheduled: "${task.name}" — ${task.schedule}`,
      }
    },
  })

  registerTool({
    name: 'list_schedules',
    description: 'List all scheduled recurring tasks.',
    parameters: [],
    permissionLevel: 'read_only',
    concurrencySafe: true,
    async execute(_params: Record<string, any>, _ctx: ToolContext): Promise<ToolResult> {
      const tasks = getScheduledTasks()
      if (tasks.length === 0) {
        return { success: true, log: 'No scheduled tasks', result: 'No scheduled tasks' }
      }

      const lines = tasks.map(t =>
        `${t.enabled ? '✓' : '✗'} ${t.name} | ${t.schedule} | Last: ${t.lastRun || 'never'} | Next: ${t.nextRun || 'N/A'}`
      )

      return {
        success: true,
        log: `Scheduled tasks (${tasks.length}):\n${lines.join('\n')}`,
        result: `${tasks.length} scheduled tasks`,
      }
    },
  })

  registerTool({
    name: 'remove_schedule',
    description: 'Remove a scheduled task by name or ID.',
    parameters: [
      { name: 'name', type: 'string', description: 'Name or ID of the scheduled task to remove', required: true },
    ],
    permissionLevel: 'write',
    concurrencySafe: true,
    async execute(params: Record<string, any>, _ctx: ToolContext): Promise<ToolResult> {
      const removed = removeScheduledTask(params.name)
      if (removed) {
        return { success: true, log: `Removed scheduled task: ${params.name}`, result: 'Task removed' }
      }
      return { success: false, log: `Task not found: ${params.name}`, result: '', error: 'Task not found' }
    },
  })
}
