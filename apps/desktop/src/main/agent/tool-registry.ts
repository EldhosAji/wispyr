/**
 * Tool Registry — provider-agnostic tool system for Wispyr.
 *
 * Each tool declares its name, description, parameter schema, permission level,
 * and whether it's safe to run concurrently with other tools.
 *
 * The registry converts tools into:
 * - Native tool-calling format for providers that support it (Anthropic, OpenAI, Gemini)
 * - System-prompt text for providers that don't (Ollama, custom)
 */

// ─── Types ───

export interface ToolParameter {
  name: string
  type: 'string' | 'number' | 'boolean' | 'object' | 'array'
  description: string
  required?: boolean
  enum?: string[]
  items?: { type: string }
  properties?: Record<string, Omit<ToolParameter, 'name' | 'required'>>
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: ToolParameter[]
  permissionLevel: 'read_only' | 'write' | 'destructive' | 'system'
  concurrencySafe: boolean
  execute: (params: Record<string, any>, context: ToolContext) => Promise<ToolResult>
}

export interface ToolContext {
  folder: string
  fileCache: Map<string, string>
  prevOutputs: string[]
}

export interface ToolResult {
  success: boolean
  log: string
  result: string
  error?: string
}

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, any>
}

export interface ToolCallResult {
  toolCallId: string
  name: string
  result: ToolResult
  permissionLevel: 'read_only' | 'write' | 'destructive' | 'system'
}

// ─── Registry ───

const _tools = new Map<string, ToolDefinition>()

export function registerTool(tool: ToolDefinition): void {
  _tools.set(tool.name, tool)
}

export function getTool(name: string): ToolDefinition | undefined {
  return _tools.get(name)
}

export function getAllTools(): ToolDefinition[] {
  return Array.from(_tools.values())
}

export function getToolNames(): string[] {
  return Array.from(_tools.keys())
}

// ─── Schema Conversion: Native Tool Calling Formats ───

/** Convert a tool to OpenAI/Groq function-calling format */
export function toOpenAITool(tool: ToolDefinition): object {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: toJsonSchema(tool.parameters),
    },
  }
}

/** Convert a tool to Anthropic tool format */
export function toAnthropicTool(tool: ToolDefinition): object {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: toJsonSchema(tool.parameters),
  }
}

/** Convert a tool to Gemini function declaration format */
export function toGeminiTool(tool: ToolDefinition): object {
  return {
    name: tool.name,
    description: tool.description,
    parameters: toJsonSchema(tool.parameters),
  }
}

/** Convert all registered tools to the format needed by a provider */
export function getToolsForProvider(providerType: string): object[] {
  const tools = getAllTools()
  switch (providerType) {
    case 'anthropic':
      return tools.map(toAnthropicTool)
    case 'gemini':
      return tools.map(toGeminiTool)
    case 'openai':
    case 'groq':
    case 'azure':
      return tools.map(toOpenAITool)
    default:
      // Provider doesn't support native tool calling — return empty
      // Tools will be embedded in system prompt instead
      return []
  }
}

/** Check if a provider supports native tool/function calling */
export function supportsNativeToolCalling(providerType: string): boolean {
  return ['anthropic', 'openai', 'groq', 'azure', 'gemini'].includes(providerType)
}

// ─── System Prompt Generation (for providers without native tool calling) ───

/** Generate a system prompt section describing available tools as text */
export function getToolsAsSystemPrompt(): string {
  const tools = getAllTools()
  const lines: string[] = [
    'AVAILABLE TOOLS:',
    '',
    'You MUST respond with a JSON array of tool calls. Each tool call has: { "name": "tool_name", "arguments": { ... } }',
    '',
  ]

  for (const tool of tools) {
    lines.push(`## ${tool.name}`)
    lines.push(tool.description)
    lines.push('Parameters:')
    for (const p of tool.parameters) {
      const req = p.required !== false ? '(required)' : '(optional)'
      const enumStr = p.enum ? ` — one of: ${p.enum.join(', ')}` : ''
      lines.push(`  - ${p.name}: ${p.type} ${req} — ${p.description}${enumStr}`)
    }
    lines.push(`Permission: ${tool.permissionLevel}`)
    lines.push('')
  }

  lines.push('RESPONSE FORMAT:')
  lines.push('Respond with ONLY a JSON array of tool calls, no other text:')
  lines.push('[{"name": "tool_name", "arguments": {"param": "value"}}, ...]')

  return lines.join('\n')
}

// ─── Internal Helpers ───

function toJsonSchema(params: ToolParameter[]): object {
  const properties: Record<string, any> = {}
  const required: string[] = []

  for (const p of params) {
    const prop: any = {
      type: p.type,
      description: p.description,
    }
    if (p.enum) prop.enum = p.enum
    if (p.items) prop.items = p.items
    if (p.properties) {
      prop.properties = {}
      for (const [key, val] of Object.entries(p.properties)) {
        prop.properties[key] = { type: val.type, description: val.description }
      }
    }
    properties[p.name] = prop
    if (p.required !== false) required.push(p.name)
  }

  return {
    type: 'object',
    properties,
    required,
  }
}

// ─── Concurrent Execution ───

/**
 * Execute tool calls, running concurrency-safe ones in parallel
 * and others serially.
 */
export async function executeToolCalls(
  calls: ToolCall[],
  context: ToolContext,
  onPermission: (call: ToolCall, level: string) => Promise<boolean>,
  onProgress: (callId: string, status: string, result?: ToolResult) => void,
): Promise<ToolCallResult[]> {
  const results: ToolCallResult[] = []

  // Partition into concurrent-safe and serial
  const concurrent: ToolCall[] = []
  const serial: ToolCall[] = []

  for (const call of calls) {
    const tool = getTool(call.name)
    if (!tool) {
      results.push({
        toolCallId: call.id,
        name: call.name,
        result: { success: false, log: `Unknown tool: ${call.name}`, result: '', error: `Tool "${call.name}" not found` },
        permissionLevel: 'read_only',
      })
      continue
    }
    if (tool.concurrencySafe) {
      concurrent.push(call)
    } else {
      serial.push(call)
    }
  }

  // Run concurrent-safe tools in parallel (max 6)
  if (concurrent.length > 0) {
    const batchSize = 6
    for (let i = 0; i < concurrent.length; i += batchSize) {
      const batch = concurrent.slice(i, i + batchSize)
      const batchResults = await Promise.all(
        batch.map(call => executeSingleTool(call, context, onPermission, onProgress))
      )
      results.push(...batchResults)
    }
  }

  // Run serial tools one at a time
  for (const call of serial) {
    const result = await executeSingleTool(call, context, onPermission, onProgress)
    results.push(result)
  }

  return results
}

async function executeSingleTool(
  call: ToolCall,
  context: ToolContext,
  onPermission: (call: ToolCall, level: string) => Promise<boolean>,
  onProgress: (callId: string, status: string, result?: ToolResult) => void,
): Promise<ToolCallResult> {
  const tool = getTool(call.name)!
  const level = tool.permissionLevel

  onProgress(call.id, 'running')

  // Permission check for non-read-only
  if (level !== 'read_only') {
    const approved = await onPermission(call, level)
    if (!approved) {
      const result: ToolResult = { success: false, log: 'Permission denied by user', result: 'Skipped', error: 'Permission denied' }
      onProgress(call.id, 'skipped', result)
      return { toolCallId: call.id, name: call.name, result, permissionLevel: level }
    }
  }

  try {
    // Run pre-hooks (lazy import to avoid circular deps)
    const { runPreHooks, runPostHooks } = await import('./hooks')
    const hookResult = await runPreHooks(call.name, call.arguments, context.folder)
    if (!hookResult.allowed) {
      const result: ToolResult = { success: false, log: `Blocked by hook: ${hookResult.error}`, result: 'Blocked', error: hookResult.error }
      onProgress(call.id, 'skipped', result)
      return { toolCallId: call.id, name: call.name, result, permissionLevel: level }
    }

    const result = await tool.execute(call.arguments, context)

    // Run post-hooks (fire and forget)
    runPostHooks(call.name, call.arguments, result, context.folder).catch(() => {})

    onProgress(call.id, result.success ? 'success' : 'error', result)
    return { toolCallId: call.id, name: call.name, result, permissionLevel: level }
  } catch (err: any) {
    const result: ToolResult = { success: false, log: `Tool error: ${err.message}`, result: '', error: err.message }
    onProgress(call.id, 'error', result)
    return { toolCallId: call.id, name: call.name, result, permissionLevel: level }
  }
}
