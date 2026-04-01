/**
 * Agent Engine — the central orchestrator for Wispyr task execution.
 *
 * Replaces the old plan-then-execute model with an agentic loop:
 * 1. User sends a message
 * 2. LLM responds with text and/or tool calls
 * 3. Tools execute (with permissions)
 * 4. Results feed back to LLM
 * 5. Loop continues until LLM is done (no more tool calls)
 *
 * Works with ANY LLM:
 * - Native tool calling: Anthropic, OpenAI, Gemini, Azure, Groq
 * - System prompt fallback: Ollama, custom endpoints
 */
import type { ProviderConfig } from '../store/providers.store'
import { callLLM, callLLMStream, type LLMResponse, type StreamCallback } from '../llm/call'
import {
  createConversation, addUserMessage, addAssistantMessage,
  addToolResult, buildMessagesForProvider, getConversation,
  deleteConversation, getConversationTokenCount,
} from './conversation'
import {
  executeToolCalls, getAllTools, getTool, supportsNativeToolCalling,
  type ToolCall, type ToolCallResult, type ToolContext,
} from './tool-registry'
import { trackUsage, type TokenUsage } from './cost-tracker'
import { needsCompaction, getCompactionPlan, applyCompaction } from './compactor'
import { FileCache } from './file-cache'
import { generateSkill } from './skill-generator'

// ─── Types ───

export interface AgentEvent {
  type:
    | 'thinking'        // LLM is generating
    | 'text_delta'      // Streaming text chunk
    | 'text_done'       // Full text response available
    | 'tool_start'      // Tool execution starting
    | 'tool_progress'   // Tool execution progress
    | 'tool_result'     // Tool execution complete
    | 'permission_needed'  // Waiting for user permission
    | 'turn_complete'   // One LLM turn complete (may have more)
    | 'task_complete'   // Agent loop finished
    | 'error'           // Error occurred
    | 'cost_update'     // Token/cost update
    | 'compacting'      // Context compaction in progress
    | 'skill_generating' // Auto-generating a new skill

  text?: string
  toolCall?: ToolCall
  toolResult?: ToolCallResult
  error?: string
  usage?: TokenUsage
  costUSD?: number
  totalCostUSD?: number
}

export type AgentEventCallback = (event: AgentEvent) => void

export interface AgentRunOptions {
  taskId: string
  folder: string
  provider: ProviderConfig
  message: string
  onEvent: AgentEventCallback
  onPermission: (toolCall: ToolCall, level: string) => Promise<boolean>
  /** Max agentic turns (LLM calls) before stopping. Default: 15 */
  maxTurns?: number
  /** Whether to use streaming. Default: true */
  stream?: boolean
  /** Whether this is a follow-up message in an existing conversation */
  isFollowUp?: boolean
  /** Abort signal */
  abortSignal?: AbortSignal
}

// ─── File caches per task ───
const _fileCaches = new Map<string, FileCache>()

// ─── Main Agent Loop ───

export async function runAgent(options: AgentRunOptions): Promise<void> {
  const {
    taskId, folder, provider, message, onEvent, onPermission,
    maxTurns = 15, stream = true, isFollowUp = false, abortSignal,
  } = options

  // Initialize or resume conversation
  let conv = getConversation(taskId)
  if (!conv || !isFollowUp) {
    conv = createConversation(taskId, folder)
  }

  // Initialize file cache
  if (!_fileCaches.has(taskId)) {
    _fileCaches.set(taskId, new FileCache())
  }
  const fileCache = _fileCaches.get(taskId)!

  // Add user message
  addUserMessage(taskId, message)

  // Agent loop
  let turn = 0

  while (turn < maxTurns) {
    if (abortSignal?.aborted) {
      onEvent({ type: 'error', error: 'Task cancelled' })
      return
    }

    turn++
    console.log(`[Agent] Turn ${turn} starting for task ${taskId}`)
    onEvent({ type: 'thinking' })

    // Check for context compaction
    if (needsCompaction(conv)) {
      onEvent({ type: 'compacting' })
      await compactConversation(taskId, provider, onEvent)
    }

    // Build messages for the provider
    const { messages, tools, systemPrompt } = await buildMessagesForProvider(taskId, provider)
    console.log(`[Agent] Built ${messages.length} messages, ${tools?.length || 0} tools for ${provider.type}`)

    // Call LLM
    let response: LLMResponse

    // Use non-streaming for reliability
    response = await callLLM(provider, messages, { tools })

    // If Azure "invalid content" error, retry without tools (let it use text-based tool calling)
    if (response.error && response.error.includes('invalid content')) {
      console.log(`[Agent] Azure model error — retrying without native tools`)
      response = await callLLM(provider, messages)
    }

    console.log(`[Agent] Response: content=${response.content?.length || 0} chars, toolCalls=${response.toolCalls?.length || 0}, error=${response.error || 'none'}, usage=${JSON.stringify(response.usage)}`)

    if (response.error) {
      console.log(`[Agent] ERROR: ${response.error}`)
      onEvent({ type: 'error', error: response.error })
      return
    }

    // Track cost
    trackUsage(taskId, provider.model, provider.type, response.usage, response.durationMs)
    onEvent({
      type: 'cost_update',
      usage: response.usage,
      costUSD: response.usage.inputTokens > 0 || response.usage.outputTokens > 0
        ? undefined
        : 0,
    })

    // Handle response
    const hasToolCalls = response.toolCalls && response.toolCalls.length > 0
    let toolCalls = response.toolCalls || []

    // For providers without native tool calling, parse tool calls from text
    if (!hasToolCalls && !supportsNativeToolCalling(provider.type) && response.content) {
      toolCalls = parseToolCallsFromText(response.content)
    }

    console.log(`[Agent] hasToolCalls=${hasToolCalls}, toolCalls.length=${toolCalls.length}, content preview="${response.content?.substring(0, 100)}"`)

    // Save assistant message
    addAssistantMessage(taskId, response.content, toolCalls.length > 0 ? toolCalls : undefined)

    if (response.content && !hasToolCalls) {
      console.log(`[Agent] Emitting text_done`)
      onEvent({ type: 'text_done', text: response.content })
    }

    // If no tool calls, we're done
    if (toolCalls.length === 0) {
      console.log(`[Agent] No tool calls, emitting task_complete`)
      onEvent({ type: 'task_complete', text: response.content })
      return
    }

    // Execute tool calls
    const toolContext: ToolContext = {
      folder,
      fileCache: fileCache.toMap(),
      prevOutputs: [],
    }

    const results = await executeToolCalls(
      toolCalls,
      toolContext,
      async (call, level) => {
        onEvent({ type: 'permission_needed', toolCall: call })
        return await onPermission(call, level)
      },
      (callId, status, result) => {
        if (status === 'running') {
          const call = toolCalls.find(tc => tc.id === callId)
          if (call) onEvent({ type: 'tool_start', toolCall: call })
        } else if (result) {
          onEvent({
            type: 'tool_result',
            toolResult: { toolCallId: callId, name: '', result, permissionLevel: 'read_only' },
          })
        }
      },
    )

    // Check if all tool calls failed — trigger skill generation
    const allFailed = results.length > 0 && results.every(r => !r.result.success)
    if (allFailed && turn <= 2) {
      console.log(`[Agent] All ${results.length} tool calls failed. Attempting auto-skill generation...`)

      const failedDetails = results.map(r => `${r.name}: ${r.result.error}`).join('\n')
      onEvent({ type: 'skill_generating', text: `Built-in tools failed. Generating a custom skill...` })

      const skillResult = await generateSkill(
        provider,
        `${message}\n\nThe following tool calls were attempted but failed:\n${failedDetails}`,
        folder,
        (msg) => onEvent({ type: 'skill_generating', text: msg }),
      )

      if (skillResult.success && skillResult.skill) {
        // Skill generated — execute it IMMEDIATELY instead of looping back to LLM
        const skillName = `gen.${skillResult.skill.name}`
        console.log(`[Agent] Executing generated skill "${skillName}" directly`)

        const skillTool = getTool(skillName)
        if (skillTool) {
          onEvent({ type: 'tool_start', toolCall: { id: `skill-${Date.now()}`, name: skillName, arguments: {} } })

          const skillExecResult = await skillTool.execute({}, toolContext)

          onEvent({
            type: 'tool_result',
            toolResult: {
              toolCallId: `skill-${Date.now()}`,
              name: skillName,
              result: skillExecResult,
              permissionLevel: skillTool.permissionLevel,
            },
          })

          // Feed result back to conversation for context
          for (const r of results) {
            addToolResult(taskId, r.toolCallId, r.name,
              skillExecResult.success
                ? `Auto-generated skill "${skillName}" executed successfully:\n${skillExecResult.log}`
                : `Auto-generated skill "${skillName}" failed: ${skillExecResult.error}`)
          }

          if (skillExecResult.success) {
            // Done — the skill did the work
            onEvent({ type: 'task_complete', text: `Task completed using auto-generated skill "${skillResult.skill.name}".\n${skillExecResult.result}` })
            return
          }
        }

        // Skill execution failed or tool not found — fall through to normal flow
        for (const r of results) {
          addToolResult(taskId, r.toolCallId, r.name, `Skill generation succeeded but execution failed.`)
        }
        onEvent({ type: 'turn_complete' })
        continue
      }
    }

    // Feed tool results back into conversation
    for (const r of results) {
      const resultText = r.result.success
        ? r.result.log
        : `Error: ${r.result.error || 'Unknown error'}`
      addToolResult(taskId, r.toolCallId, r.name, resultText)
    }

    onEvent({ type: 'turn_complete' })

    // Loop continues — LLM will process tool results
  }

  // Max turns reached
  onEvent({ type: 'error', error: `Agent reached maximum turns (${maxTurns}). Task may be incomplete.` })
  onEvent({ type: 'task_complete' })
}

// ─── Compaction ───

async function compactConversation(
  taskId: string,
  provider: ProviderConfig,
  onEvent: AgentEventCallback,
): Promise<void> {
  const conv = getConversation(taskId)
  if (!conv) return

  const plan = getCompactionPlan(conv.messages)
  if (plan.toSummarize.length === 0) return

  try {
    // Use the LLM to summarize
    const response = await callLLM(provider, [
      { role: 'system', content: 'You are a conversation summarizer. Be concise but preserve all important details.' },
      { role: 'user', content: plan.summaryPrompt },
    ])

    if (response.content && !response.error) {
      applyCompaction(conv, plan.toKeep, response.content)
      trackUsage(taskId, provider.model, provider.type, response.usage, response.durationMs)
    }
  } catch {
    // If compaction fails, continue without it
  }
}

// ─── Parse Tool Calls from Text (for non-native providers) ───

function parseToolCallsFromText(text: string): ToolCall[] {
  // Try to find a JSON array of tool calls in the text
  let jsonStr = text.trim()

  // Strip markdown code blocks
  const codeBlock = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (codeBlock) jsonStr = codeBlock[1].trim()

  // Find JSON array
  const arrayStart = jsonStr.indexOf('[')
  const arrayEnd = jsonStr.lastIndexOf(']')
  if (arrayStart === -1 || arrayEnd === -1) return []

  jsonStr = jsonStr.substring(arrayStart, arrayEnd + 1)

  try {
    const parsed = JSON.parse(jsonStr)
    if (!Array.isArray(parsed)) return []

    return parsed.map((item: any, i: number) => ({
      id: `tc-${Date.now()}-${i}`,
      name: item.name || item.action || '',
      arguments: item.arguments || item.params || removeKeys(item, ['name', 'action']),
    })).filter((tc: ToolCall) => tc.name && getTool(tc.name))
  } catch {
    return []
  }
}

function removeKeys(obj: any, keys: string[]): Record<string, any> {
  const result: Record<string, any> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (!keys.includes(key)) result[key] = value
  }
  return result
}

// ─── Cleanup ───

export function cleanupTask(taskId: string): void {
  _fileCaches.delete(taskId)
  deleteConversation(taskId)
}
