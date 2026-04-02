/**
 * Conversation Manager — maintains multi-turn message history per task.
 *
 * Stores the full conversation (system, user, assistant, tool_result messages)
 * and provides methods to add messages, compact history, and format
 * for different LLM providers.
 */
import type { ProviderConfig } from '../store/providers.store'
import { getToolsAsSystemPrompt, supportsNativeToolCalling, getToolsForProvider } from './tool-registry'
import { loadWispyrContext } from './context-loader'

// ─── Types ───

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool_result'
  content: string
  /** For tool_result messages */
  toolCallId?: string
  toolName?: string
  /** For assistant messages with tool calls */
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, any> }>
  /** Timestamp */
  timestamp?: string
  /** Token count estimate (for compaction) */
  estimatedTokens?: number
}

export interface Conversation {
  id: string
  taskId: string
  folder: string
  messages: Message[]
  createdAt: string
  /** Total estimated tokens in the conversation */
  totalTokens: number
}

// ─── Active Conversations ───

const _conversations = new Map<string, Conversation>()

export function createConversation(taskId: string, folder: string): Conversation {
  const conv: Conversation = {
    id: taskId,
    taskId,
    folder,
    messages: [],
    createdAt: new Date().toISOString(),
    totalTokens: 0,
  }
  _conversations.set(taskId, conv)
  return conv
}

export function getConversation(taskId: string): Conversation | null {
  return _conversations.get(taskId) || null
}

export function deleteConversation(taskId: string): void {
  _conversations.delete(taskId)
}

// ─── Message Management ───

export function addMessage(taskId: string, message: Message): void {
  const conv = _conversations.get(taskId)
  if (!conv) return

  message.timestamp = message.timestamp || new Date().toISOString()
  message.estimatedTokens = estimateTokens(message.content)
  conv.messages.push(message)
  conv.totalTokens += message.estimatedTokens
}

export function addToolResult(taskId: string, toolCallId: string, toolName: string, result: string): void {
  addMessage(taskId, {
    role: 'tool_result',
    content: result,
    toolCallId,
    toolName,
  })
}

export function addAssistantMessage(taskId: string, content: string, toolCalls?: Message['toolCalls']): void {
  addMessage(taskId, {
    role: 'assistant',
    content,
    toolCalls,
  })
}

export function addUserMessage(taskId: string, content: string): void {
  addMessage(taskId, { role: 'user', content })
}

// ─── Format for LLM API ───

/**
 * Build the complete messages array for an LLM call.
 * Handles system prompt, WISPYR.md context, tool definitions,
 * and formats appropriately for the provider.
 */
export async function buildMessagesForProvider(
  taskId: string,
  provider: ProviderConfig,
): Promise<{ messages: any[]; tools?: any[]; systemPrompt: string }> {
  const conv = _conversations.get(taskId)
  if (!conv) throw new Error(`No conversation for task ${taskId}`)

  const parts: string[] = []

  parts.push(`You are Wispyr, a desktop AI agent that EXECUTES tasks by calling tools.`)
  parts.push(`NEVER explain how to do something — DO it by calling tools.`)
  parts.push(`NEVER say you can't create a file — you CAN create ALL file types.`)
  parts.push(`After work is done, give a 1-3 sentence summary.`)
  parts.push(``)
  parts.push(`You MUST use write_file to create files. For .xlsx/.docx/.pdf/.pptx use the "data" parameter:`)
  parts.push(``)
  parts.push(`EXCEL: write_file(fileName:"x.xlsx", data:{"sheets":[{"name":"S1","headers":["A","B"],"rows":[["v1","v2"]]}],"charts":[{"type":"pie","title":"T","dataSheet":"S1","categoryColumn":"A","valueColumn":"B","startRow":2,"endRow":5}]})`)
  parts.push(`WORD: write_file(fileName:"x.docx", data:{"title":"T","content":[{"type":"heading","text":"H","level":1},{"type":"paragraph","text":"P"},{"type":"bullet","items":["I"]},{"type":"table","headers":["H"],"rows":[["R"]]}]})`)
  parts.push(`PDF: write_file(fileName:"x.pdf", data:{"title":"T","content":[{"type":"heading","text":"H"},{"type":"paragraph","text":"P"},{"type":"list","items":["I"]}]})`)
  parts.push(`PPTX: write_file(fileName:"x.pptx", data:{"title":"T","slides":[{"title":"Slide","content":"Body text","bullets":["Point 1"],"notes":"Notes"}]})`)
  parts.push(`CSV: write_file(fileName:"x.csv", data:{"headers":["A","B"],"rows":[["v1","v2"]]})`)
  parts.push(`TEXT: write_file(fileName:"x.txt", content:"full text here")`)
  parts.push(``)
  parts.push(`If a tool can't do something, call generate_skill to auto-create the capability.`)
  parts.push(``)
  parts.push(`Working folder: ${conv.folder}`)
  parts.push(`Date: ${new Date().toISOString().split('T')[0]}`)

  // WISPYR.md context (like CLAUDE.md in Claude Code)
  const wispyrContext = loadWispyrContext(conv.folder)
  if (wispyrContext) {
    parts.push(``)
    parts.push(wispyrContext)
  }

  // For providers without native tool calling, embed tool definitions
  const nativeTools = supportsNativeToolCalling(provider.type)
  if (!nativeTools) {
    parts.push('')
    parts.push(getToolsAsSystemPrompt())
  }

  const systemPrompt = parts.join('\n')

  // Format conversation messages for the provider
  const formattedMessages = formatMessagesForProvider(conv.messages, provider.type, systemPrompt)

  // Get native tool definitions if supported
  const tools = nativeTools ? getToolsForProvider(provider.type) : undefined

  return {
    messages: formattedMessages,
    tools: tools && tools.length > 0 ? tools : undefined,
    systemPrompt,
  }
}

// ─── Provider-specific message formatting ───

function formatMessagesForProvider(messages: Message[], providerType: string, systemPrompt: string): any[] {
  switch (providerType) {
    case 'anthropic':
      return formatForAnthropic(messages, systemPrompt)
    case 'gemini':
      return formatForGemini(messages, systemPrompt)
    default:
      return formatForOpenAI(messages, systemPrompt)
  }
}

/** Anthropic: system goes in a separate field, tool_results are special */
function formatForAnthropic(messages: Message[], _systemPrompt: string): any[] {
  const formatted: any[] = []

  for (const msg of messages) {
    if (msg.role === 'system') continue // handled separately

    if (msg.role === 'tool_result') {
      formatted.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: msg.toolCallId,
          content: msg.content,
        }],
      })
    } else if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      const content: any[] = []
      if (msg.content) content.push({ type: 'text', text: msg.content })
      for (const tc of msg.toolCalls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: tc.arguments,
        })
      }
      formatted.push({ role: 'assistant', content })
    } else {
      formatted.push({ role: msg.role, content: msg.content })
    }
  }

  return formatted
}

/** OpenAI/Azure/Groq: tool_results become role:"tool" messages */
function formatForOpenAI(messages: Message[], systemPrompt: string): any[] {
  const formatted: any[] = [{ role: 'system', content: systemPrompt }]

  for (const msg of messages) {
    if (msg.role === 'system') continue

    if (msg.role === 'tool_result') {
      formatted.push({
        role: 'tool',
        tool_call_id: msg.toolCallId,
        content: msg.content,
      })
    } else if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      formatted.push({
        role: 'assistant',
        content: msg.content || null,
        tool_calls: msg.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      })
    } else {
      formatted.push({ role: msg.role, content: msg.content })
    }
  }

  return formatted
}

/** Gemini: different role names and function call format */
function formatForGemini(messages: Message[], systemPrompt: string): any[] {
  const formatted: any[] = []

  // Gemini system instruction is separate, not in messages
  for (const msg of messages) {
    if (msg.role === 'system') continue

    if (msg.role === 'tool_result') {
      formatted.push({
        role: 'user',
        parts: [{
          functionResponse: {
            name: msg.toolName || '',
            response: { result: msg.content },
          },
        }],
      })
    } else if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      const parts: any[] = []
      if (msg.content) parts.push({ text: msg.content })
      for (const tc of msg.toolCalls) {
        parts.push({
          functionCall: { name: tc.name, args: tc.arguments },
        })
      }
      formatted.push({ role: 'model', parts })
    } else {
      formatted.push({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }],
      })
    }
  }

  return formatted
}

// ─── Token Estimation ───

/** Rough token estimate: ~4 chars per token for English text */
function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

export function getConversationTokenCount(taskId: string): number {
  const conv = _conversations.get(taskId)
  return conv ? conv.totalTokens : 0
}
