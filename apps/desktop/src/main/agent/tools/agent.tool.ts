/**
 * Sub-Agent Tool — spawn child agents for subtasks.
 * The parent agent continues while the child works independently.
 * Results are returned when the child completes.
 */
import { registerTool, type ToolContext, type ToolResult } from '../tool-registry'
import { runAgent, type AgentEvent } from '../engine'
import * as providersStore from '../../store/providers.store'

// Track active sub-agents to enforce limits
const _activeSubAgents = new Map<string, { taskId: string; abortController: AbortController }>()
const MAX_CONCURRENT = 3
const MAX_DEPTH = 2

let _currentDepth = 0

export function registerAgentTool(): void {
  registerTool({
    name: 'spawn_agent',
    description: 'Spawn a sub-agent to handle a subtask independently. Use for parallel work or complex multi-step subtasks. The sub-agent has access to all tools.',
    parameters: [
      { name: 'task', type: 'string', description: 'Task description for the sub-agent', required: true },
      { name: 'name', type: 'string', description: 'Short name for this agent (e.g. "researcher", "writer")', required: false },
    ],
    permissionLevel: 'write',
    concurrencySafe: false,
    async execute(params: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
      const provider = providersStore.getActiveProvider()
      if (!provider) {
        return { success: false, log: 'No LLM provider', result: '', error: 'No active provider' }
      }

      if (_activeSubAgents.size >= MAX_CONCURRENT) {
        return { success: false, log: `Max ${MAX_CONCURRENT} concurrent sub-agents`, result: '', error: 'Too many sub-agents' }
      }

      if (_currentDepth >= MAX_DEPTH) {
        return { success: false, log: `Max nesting depth ${MAX_DEPTH} reached`, result: '', error: 'Sub-agent nesting too deep' }
      }

      const taskId = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
      const agentName = params.name || 'sub-agent'
      const abortController = new AbortController()
      _activeSubAgents.set(taskId, { taskId, abortController })
      _currentDepth++

      const logs: string[] = []
      let finalText = ''

      try {
        await runAgent({
          taskId,
          folder: ctx.folder,
          provider,
          message: params.task,
          maxTurns: 10,
          stream: false,
          abortSignal: abortController.signal,
          onEvent: (event: AgentEvent) => {
            if (event.type === 'text_done' && event.text) {
              finalText = event.text
            } else if (event.type === 'tool_result' && event.toolResult?.result.success) {
              logs.push(`[${event.toolResult.name}] ${event.toolResult.result.result}`)
            } else if (event.type === 'error') {
              logs.push(`Error: ${event.error}`)
            }
          },
          onPermission: async () => true, // Sub-agents auto-approve (parent already approved spawning)
        })

        const summary = [
          `Sub-agent "${agentName}" completed.`,
          logs.length > 0 ? `\nActions:\n${logs.join('\n')}` : '',
          finalText ? `\nResponse:\n${finalText}` : '',
        ].filter(Boolean).join('\n')

        return { success: true, log: summary, result: finalText || 'Sub-agent completed' }
      } catch (err: any) {
        return { success: false, log: `Sub-agent failed: ${err.message}`, result: '', error: err.message }
      } finally {
        _activeSubAgents.delete(taskId)
        _currentDepth--
      }
    },
  })
}
