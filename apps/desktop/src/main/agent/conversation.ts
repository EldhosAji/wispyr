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

  // Build system prompt
  const parts: string[] = []

  parts.push(`You are Wispyr, a desktop AI agent that EXECUTES real tasks on the user's computer by calling tools.`)
  parts.push(`You have FULL capability to create ANY file type: Excel (.xlsx), Word (.docx), PDF, PowerPoint (.pptx), CSV, and all text files.`)
  parts.push(``)
  parts.push(`CRITICAL RULES:`)
  parts.push(`1. You MUST call tools to perform actions. NEVER just explain, describe, or give instructions.`)
  parts.push(`2. NEVER say "I can't" or "not supported" — if a tool doesn't exist for what you need, call generate_skill to CREATE the capability.`)
  parts.push(`3. NEVER suggest the user do something manually. YOU do it by calling tools.`)
  parts.push(`4. Generate REAL, COMPLETE, USEFUL content with realistic sample data.`)
  parts.push(`5. If a tool call fails, fix the parameters and retry. Do NOT give up or switch to text explanations.`)
  parts.push(`6. After creating a file, call read_file to verify it was created correctly.`)
  parts.push(`7. When the task is done, give a SHORT summary (2-3 lines max): what was created, where, and key details.`)
  parts.push(`8. NEVER give step-by-step manual instructions. NEVER tell the user to open Excel and do things. You are the agent — YOU do the work.`)
  parts.push(``)
  parts.push(`GENERATE_SKILL TOOL — IMPORTANT:`)
  parts.push(`When you need a capability that no existing tool provides (e.g. adding charts to Excel, resizing images,`)
  parts.push(`parsing complex data, converting file formats, web scraping, etc.), call the generate_skill tool.`)
  parts.push(`It will automatically write code, test it in a sandbox, and execute it.`)
  parts.push(`Example: To add a chart to an Excel file, call generate_skill with task="Add a pie chart to expense_tracker.xlsx showing expenses by category"`)
  parts.push(`The system handles everything — you just describe what you need.`)
  parts.push(``)
  parts.push(`FILE FORMAT RULES (IMPORTANT — follow exactly):`)
  parts.push(`- Excel (.xlsx): write_file with "data" parameter: { "sheets": [{ "name": "Sheet1", "headers": ["Col1","Col2"], "rows": [["val1","val2"]] }] }`)
  parts.push(`  The "headers" field is REQUIRED. "rows" contains data rows (without headers).`)
  parts.push(`- Word (.docx): write_file with "data" parameter: { "title": "Doc Title", "content": [{ "type": "paragraph", "text": "..." }] }`)
  parts.push(`- PDF (.pdf): write_file with "data" parameter: { "title": "Title", "content": [{ "type": "paragraph", "text": "..." }] }`)
  parts.push(`- PowerPoint (.pptx): write_file with "data" parameter: { "title": "Title", "slides": [{ "title": "Slide 1", "bullets": ["Point"] }] }`)
  parts.push(`- CSV (.csv): write_file with "data" parameter: { "headers": ["Col1","Col2"], "rows": [["val1","val2"]] }`)
  parts.push(`- Text files (.txt, .md, .json, etc.): write_file with "content" parameter (full text string).`)
  parts.push(`- NEVER use "content" for .xlsx/.docx/.pdf/.pptx — always use "data" with the structure above.`)
  parts.push(``)
  parts.push(`Working folder: ${conv.folder}`)
  parts.push(`Current date: ${new Date().toISOString().split('T')[0]}`)

  // Load WISPYR.md context
  const wispyrContext = loadWispyrContext(conv.folder)
  if (wispyrContext) {
    parts.push('')
    parts.push('PROJECT CONTEXT (from WISPYR.md):')
    parts.push(wispyrContext)
  }

  // For providers without native tool calling, embed full tool definitions in prompt
  const nativeTools = supportsNativeToolCalling(provider.type)
  if (!nativeTools) {
    parts.push('')
    parts.push(getToolsAsSystemPrompt())
  }

  // Always include a brief tool reference so the LLM knows what's available
  if (nativeTools) {
    parts.push('')
    parts.push('Available tools: write_file, read_file, append_file, list_dir, create_dir, delete_file, move_file, copy_file, search_files, organise, generate_skill')
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
