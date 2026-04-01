/**
 * Context Compactor — summarizes older messages when the conversation
 * approaches token limits.
 *
 * Strategy: Keep the system prompt + last N messages intact.
 * Summarize everything in between into a compact summary message.
 * Works with any LLM — uses the same provider to generate summaries.
 */
import type { Message, Conversation } from './conversation'

// ─── Configuration ───

/** Max estimated tokens before triggering compaction */
const COMPACTION_THRESHOLD = 80_000

/** Number of recent messages to always keep intact */
const KEEP_RECENT_COUNT = 10

/** Target token count after compaction */
const TARGET_TOKENS = 40_000

// ─── Compaction ───

/**
 * Check if a conversation needs compaction.
 */
export function needsCompaction(conversation: Conversation): boolean {
  return conversation.totalTokens > COMPACTION_THRESHOLD
}

/**
 * Compact a conversation's message history by summarizing older messages.
 * Returns the messages to summarize (for LLM summarization) and the
 * messages to keep.
 *
 * Call flow:
 * 1. Check needsCompaction()
 * 2. Call getCompactionPlan() to get what to summarize
 * 3. Send the summary prompt to the LLM
 * 4. Call applyCompaction() with the summary
 */
export function getCompactionPlan(messages: Message[]): {
  toSummarize: Message[]
  toKeep: Message[]
  summaryPrompt: string
} {
  // Always keep system messages
  const systemMessages = messages.filter(m => m.role === 'system')
  const nonSystemMessages = messages.filter(m => m.role !== 'system')

  // Keep the last N messages intact
  const keepCount = Math.min(KEEP_RECENT_COUNT, nonSystemMessages.length)
  const toKeep = nonSystemMessages.slice(-keepCount)
  const toSummarize = nonSystemMessages.slice(0, -keepCount)

  if (toSummarize.length === 0) {
    return { toSummarize: [], toKeep: messages, summaryPrompt: '' }
  }

  // Build a summary prompt
  const summaryLines: string[] = [
    'Summarize the following conversation history into a concise context summary.',
    'Preserve: key decisions, file operations performed, important results, and any errors.',
    'Be brief but complete. Output only the summary, no other text.',
    '',
    '--- CONVERSATION HISTORY ---',
  ]

  for (const msg of toSummarize) {
    const role = msg.role === 'tool_result' ? `tool(${msg.toolName || 'unknown'})` : msg.role
    const content = msg.content.length > 500 ? msg.content.substring(0, 500) + '...' : msg.content
    summaryLines.push(`[${role}]: ${content}`)
  }

  return {
    toSummarize,
    toKeep: [...systemMessages, ...toKeep],
    summaryPrompt: summaryLines.join('\n'),
  }
}

/**
 * Apply compaction by replacing old messages with a summary.
 */
export function applyCompaction(
  conversation: Conversation,
  keptMessages: Message[],
  summary: string,
): void {
  const summaryMessage: Message = {
    role: 'user',
    content: `[Previous conversation summary]: ${summary}`,
    timestamp: new Date().toISOString(),
    estimatedTokens: Math.ceil(summary.length / 4),
  }

  // Find index to insert summary (after system messages, before kept messages)
  const systemMessages = keptMessages.filter(m => m.role === 'system')
  const nonSystemKept = keptMessages.filter(m => m.role !== 'system')

  conversation.messages = [...systemMessages, summaryMessage, ...nonSystemKept]
  conversation.totalTokens = conversation.messages.reduce(
    (sum, m) => sum + (m.estimatedTokens || Math.ceil(m.content.length / 4)),
    0,
  )
}
