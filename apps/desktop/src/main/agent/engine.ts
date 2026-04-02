/**
 * Agent Engine v2 — Generator-based state machine inspired by Claude Code's query loop.
 *
 * Key design principles (from .reference/src/query.ts):
 * 1. Generator yields events — UI subscribes to them
 * 2. State transitions are explicit — every `continue` carries full state
 * 3. Error recovery is staged — retry → fallback → surface
 * 4. Tools execute during streaming, not after
 * 5. System prompt is minimal — don't over-instruct the model
 */
import type { ProviderConfig } from '../store/providers.store'
import { callLLM, callLLMStream, type LLMResponse, type StreamCallback } from '../llm/call'
import {
  createConversation, addUserMessage, addAssistantMessage,
  addToolResult, buildMessagesForProvider, getConversation,
  deleteConversation,
} from './conversation'
import {
  executeToolCalls, getAllTools, getTool, supportsNativeToolCalling,
  type ToolCall, type ToolCallResult, type ToolContext,
} from './tool-registry'
import { trackUsage, type TokenUsage } from './cost-tracker'
import { needsCompaction, getCompactionPlan, applyCompaction } from './compactor'
import { FileCache } from './file-cache'

// ─── Types ───

export interface AgentEvent {
  type:
    | 'thinking'
    | 'text_delta'
    | 'text_done'
    | 'tool_start'
    | 'tool_progress'
    | 'tool_result'
    | 'permission_needed'
    | 'turn_complete'
    | 'task_complete'
    | 'error'
    | 'cost_update'
    | 'compacting'
    | 'skill_generating'
    | 'fallback'

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
  maxTurns?: number
  stream?: boolean
  isFollowUp?: boolean
  abortSignal?: AbortSignal
}

// File caches per task
const _fileCaches = new Map<string, FileCache>()

// ─── Main Agent Loop ───

export async function runAgent(options: AgentRunOptions): Promise<void> {
  const {
    taskId, folder, provider, message, onEvent, onPermission,
    maxTurns = 20, isFollowUp = false, abortSignal,
  } = options

  // Initialize conversation
  let conv = getConversation(taskId)
  if (!conv || !isFollowUp) {
    conv = createConversation(taskId, folder)
  }

  if (!_fileCaches.has(taskId)) {
    _fileCaches.set(taskId, new FileCache())
  }
  const fileCache = _fileCaches.get(taskId)!

  addUserMessage(taskId, message)

  // ─── State machine ───
  let turnCount = 0
  let consecutiveErrors = 0
  let useNativeTools = supportsNativeToolCalling(provider.type)

  while (turnCount < maxTurns) {
    if (abortSignal?.aborted) {
      onEvent({ type: 'error', error: 'Cancelled' })
      return
    }

    turnCount++
    onEvent({ type: 'thinking' })

    // ─── Compaction check ───
    if (conv && needsCompaction(conv)) {
      onEvent({ type: 'compacting' })
      try {
        const plan = getCompactionPlan(conv.messages)
        if (plan.toSummarize.length > 0) {
          const summaryResp = await callLLM(provider, [
            { role: 'system', content: 'Summarize this conversation history concisely. Preserve key decisions and file operations.' },
            { role: 'user', content: plan.summaryPrompt },
          ])
          if (summaryResp.content) {
            applyCompaction(conv, plan.toKeep, summaryResp.content)
          }
        }
      } catch { /* continue without compaction */ }
    }

    // ─── Build messages ───
    const { messages, tools, systemPrompt } = await buildMessagesForProvider(taskId, provider)
    const toolsToSend = useNativeTools ? tools : undefined

    // ─── Call LLM ───
    let response: LLMResponse

    try {
      response = await callLLM(provider, messages, { tools: toolsToSend })
    } catch (err: any) {
      // Stage 1: Retry without tools (Azure "invalid content" fix)
      if (useNativeTools && consecutiveErrors === 0) {
        console.log(`[Engine] LLM error, retrying without native tools: ${err.message}`)
        onEvent({ type: 'fallback', text: 'Retrying with text-based tool calling...' })
        useNativeTools = false
        consecutiveErrors++
        continue
      }
      onEvent({ type: 'error', error: err.message })
      return
    }

    // ─── Handle LLM errors with staged recovery ───
    if (response.error) {
      consecutiveErrors++

      // Stage 1: If native tools failed, retry without them
      if (useNativeTools && response.error.includes('invalid content')) {
        console.log(`[Engine] Azure invalid content — falling back to text-based tools`)
        useNativeTools = false
        onEvent({ type: 'fallback', text: 'Switching to text-based tool calling...' })
        turnCount-- // Don't count this as a turn
        continue
      }

      // Stage 2: If we've had 3+ consecutive errors, give up
      if (consecutiveErrors >= 3) {
        onEvent({ type: 'error', error: `Persistent error after ${consecutiveErrors} attempts: ${response.error}` })
        return
      }

      // Stage 3: Retry once
      console.log(`[Engine] Error (attempt ${consecutiveErrors}): ${response.error}`)
      onEvent({ type: 'error', error: response.error })
      continue
    }

    // Reset error counter on success
    consecutiveErrors = 0

    // ─── Track cost ───
    trackUsage(taskId, provider.model, provider.type, response.usage, response.durationMs)
    onEvent({ type: 'cost_update', usage: response.usage })

    // ─── Parse tool calls ───
    let toolCalls = response.toolCalls || []

    // For providers without native tool calling, parse from text
    if (toolCalls.length === 0 && !useNativeTools && response.content) {
      toolCalls = parseToolCallsFromText(response.content)
    }

    // Save assistant message
    addAssistantMessage(taskId, response.content, toolCalls.length > 0 ? toolCalls : undefined)

    // ─── No tool calls → task complete ───
    if (toolCalls.length === 0) {
      if (response.content) {
        onEvent({ type: 'text_done', text: response.content })
      }
      onEvent({ type: 'task_complete', text: response.content })
      return
    }

    // Emit text if present alongside tool calls
    if (response.content) {
      onEvent({ type: 'text_done', text: response.content })
    }

    // ─── Execute tools ───
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

    // Feed results back into conversation
    for (const r of results) {
      const resultText = r.result.success
        ? r.result.log
        : `Error: ${r.result.error || 'Unknown error'}`
      addToolResult(taskId, r.toolCallId, r.name, resultText)
    }

    onEvent({ type: 'turn_complete' })

    // ─── Check turn limit ───
    if (turnCount >= maxTurns) {
      onEvent({ type: 'error', error: `Reached maximum ${maxTurns} turns.` })
      onEvent({ type: 'task_complete' })
      return
    }
  }
}

// ─── Parse tool calls from text (for non-native providers) ───

function parseToolCallsFromText(text: string): ToolCall[] {
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
