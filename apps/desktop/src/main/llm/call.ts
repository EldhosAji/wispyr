import https from 'https'
import http from 'http'
import type { ProviderConfig } from '../store/providers.store'
import { extractUsage, type TokenUsage } from '../agent/cost-tracker'

// ─── Types ───

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | 'model'
  content: string | any[] | null
  tool_calls?: any[]
  tool_call_id?: string
  parts?: any[]
  name?: string
}

export interface LLMResponse {
  content: string
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, any> }>
  usage: TokenUsage
  rawResponse?: any
  error?: string
  durationMs: number
}

export type StreamCallback = (chunk: {
  type: 'text' | 'tool_call_start' | 'tool_call_delta' | 'tool_call_end' | 'done' | 'error'
  text?: string
  toolCall?: { id: string; name: string; arguments: string }
  usage?: TokenUsage
  error?: string
}) => void

// ─── Main Entry Points ───

/**
 * Call an LLM provider and return the full response.
 * Supports native tool calling when tools are provided.
 */
export async function callLLM(
  provider: ProviderConfig,
  messages: LLMMessage[],
  options?: { tools?: any[]; stream?: false },
): Promise<LLMResponse> {
  const startTime = Date.now()
  console.log(`[LLM] Calling ${provider.type} provider "${provider.name}" (${provider.model})`)

  let result: LLMResponse

  try {
    if (provider.type === 'anthropic') {
      result = await callAnthropic(provider, messages, options?.tools)
    } else if (provider.type === 'gemini') {
      result = await callGemini(provider, messages, options?.tools)
    } else if (provider.type === 'azure') {
      result = await callAzureOpenAI(provider, messages, options?.tools)
    } else {
      result = await callOpenAICompatible(provider, messages, options?.tools)
    }
  } catch (err: any) {
    result = { content: '', usage: { inputTokens: 0, outputTokens: 0 }, error: err.message, durationMs: Date.now() - startTime }
  }

  result.durationMs = Date.now() - startTime

  if (result.error) {
    console.log(`[LLM] Error (${result.durationMs}ms): ${result.error}`)
  } else {
    console.log(`[LLM] Success (${result.durationMs}ms): ${result.content.length} chars, ${result.toolCalls?.length || 0} tool calls`)
  }

  return result
}

/**
 * Call an LLM provider with streaming. Chunks are delivered via callback.
 * Returns the final assembled response.
 */
export async function callLLMStream(
  provider: ProviderConfig,
  messages: LLMMessage[],
  onChunk: StreamCallback,
  options?: { tools?: any[] },
): Promise<LLMResponse> {
  const startTime = Date.now()
  console.log(`[LLM] Streaming ${provider.type} provider "${provider.name}" (${provider.model})`)

  let result: LLMResponse

  try {
    if (provider.type === 'anthropic') {
      result = await streamAnthropic(provider, messages, onChunk, options?.tools)
    } else if (provider.type === 'gemini') {
      // Gemini streaming uses different endpoint — fall back to non-streaming for now
      result = await callGemini(provider, messages, options?.tools)
      onChunk({ type: 'text', text: result.content })
      onChunk({ type: 'done', usage: result.usage })
    } else if (provider.type === 'azure') {
      result = await streamOpenAICompatible(provider, messages, onChunk, options?.tools, true)
    } else if (provider.type === 'ollama') {
      result = await streamOllama(provider, messages, onChunk)
    } else {
      result = await streamOpenAICompatible(provider, messages, onChunk, options?.tools, false)
    }
  } catch (err: any) {
    result = { content: '', usage: { inputTokens: 0, outputTokens: 0 }, error: err.message, durationMs: Date.now() - startTime }
    onChunk({ type: 'error', error: err.message })
  }

  result.durationMs = Date.now() - startTime
  return result
}

// ─── Anthropic ───

async function callAnthropic(provider: ProviderConfig, messages: LLMMessage[], tools?: any[]): Promise<LLMResponse> {
  const systemMsg = messages.find(m => m.role === 'system')
  const userMsgs = messages.filter(m => m.role !== 'system')

  const body: any = {
    model: provider.model,
    max_tokens: 4096,
    system: typeof systemMsg?.content === 'string' ? systemMsg.content : '',
    messages: userMsgs,
  }

  if (tools && tools.length > 0) {
    body.tools = tools
  }

  const baseUrl = provider.baseUrl.replace(/\/v1\/?$/, '')

  return httpRequestJSON(baseUrl, '/v1/messages', JSON.stringify(body), {
    'x-api-key': provider.apiKey || '',
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  }, (data) => parseAnthropicResponse(data), provider.type)
}

async function streamAnthropic(
  provider: ProviderConfig,
  messages: LLMMessage[],
  onChunk: StreamCallback,
  tools?: any[],
): Promise<LLMResponse> {
  const systemMsg = messages.find(m => m.role === 'system')
  const userMsgs = messages.filter(m => m.role !== 'system')

  const body: any = {
    model: provider.model,
    max_tokens: 4096,
    stream: true,
    system: typeof systemMsg?.content === 'string' ? systemMsg.content : '',
    messages: userMsgs,
  }

  if (tools && tools.length > 0) {
    body.tools = tools
  }

  const baseUrl = provider.baseUrl.replace(/\/v1\/?$/, '')

  return httpRequestSSE(baseUrl, '/v1/messages', JSON.stringify(body), {
    'x-api-key': provider.apiKey || '',
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  }, (event, data) => {
    // Anthropic SSE events
    if (event === 'content_block_delta') {
      if (data.delta?.type === 'text_delta') {
        onChunk({ type: 'text', text: data.delta.text })
      } else if (data.delta?.type === 'input_json_delta') {
        onChunk({ type: 'tool_call_delta', text: data.delta.partial_json })
      }
    } else if (event === 'content_block_start') {
      if (data.content_block?.type === 'tool_use') {
        onChunk({ type: 'tool_call_start', toolCall: { id: data.content_block.id, name: data.content_block.name, arguments: '' } })
      }
    } else if (event === 'content_block_stop') {
      // Could be text or tool_use end
    } else if (event === 'message_delta') {
      if (data.usage) {
        onChunk({ type: 'done', usage: { inputTokens: 0, outputTokens: data.usage.output_tokens || 0 } })
      }
    } else if (event === 'message_start') {
      // Contains input token count
      if (data.message?.usage) {
        // We'll merge this later
      }
    }
  }, (fullData) => parseAnthropicStreamFinal(fullData), provider.type)
}

// ─── OpenAI-compatible (OpenAI, Groq, Custom) ───

async function callOpenAICompatible(provider: ProviderConfig, messages: LLMMessage[], tools?: any[]): Promise<LLMResponse> {
  let apiPath: string
  if (provider.type === 'ollama') {
    apiPath = '/api/chat'
  } else if (provider.type === 'groq') {
    apiPath = '/openai/v1/chat/completions'
  } else {
    apiPath = provider.baseUrl.includes('/v1') ? '/chat/completions' : '/v1/chat/completions'
  }

  const reqBody: any = {
    model: provider.model,
    messages: messages.map(m => {
      // Pass through complex message formats (tool_calls, etc.)
      if (typeof m.content !== 'string' || m.tool_calls || m.tool_call_id) {
        return m
      }
      return { role: m.role, content: m.content }
    }),
  }

  if (provider.type !== 'ollama') {
    reqBody.max_tokens = 4096
  } else {
    reqBody.stream = false
  }

  if (tools && tools.length > 0 && provider.type !== 'ollama') {
    reqBody.tools = tools
  }

  const body = JSON.stringify(reqBody)
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}),
    ...(provider.customHeaders || {}),
  }

  const baseUrl = provider.baseUrl.replace(/\/v1\/?$/, '').replace(/\/+$/, '')

  return httpRequestJSON(baseUrl, apiPath, body, headers, (data) => parseOpenAIResponse(data, provider.type), provider.type)
}

async function streamOpenAICompatible(
  provider: ProviderConfig,
  messages: LLMMessage[],
  onChunk: StreamCallback,
  tools?: any[],
  isAzure = false,
): Promise<LLMResponse> {
  let apiPath: string
  if (isAzure) {
    apiPath = `/openai/deployments/${provider.model}/chat/completions?api-version=2024-08-01-preview`
  } else if (provider.type === 'groq') {
    apiPath = '/openai/v1/chat/completions'
  } else {
    apiPath = provider.baseUrl.includes('/v1') ? '/chat/completions' : '/v1/chat/completions'
  }

  const reqBody: any = {
    model: isAzure ? undefined : provider.model,
    messages: messages.map(m => {
      if (typeof m.content !== 'string' || m.tool_calls || m.tool_call_id) return m
      return { role: m.role, content: m.content }
    }),
    stream: true,
    max_tokens: 4096,
  }

  if (tools && tools.length > 0) {
    reqBody.tools = tools
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(isAzure
      ? { 'api-key': provider.apiKey || '' }
      : provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}),
    ...(provider.customHeaders || {}),
  }

  const baseUrl = isAzure ? provider.baseUrl : provider.baseUrl.replace(/\/v1\/?$/, '').replace(/\/+$/, '')

  const toolCallBuffers = new Map<number, { id: string; name: string; arguments: string }>()

  return httpRequestSSE(baseUrl, apiPath, JSON.stringify(reqBody), headers, (event, data) => {
    if (data === '[DONE]') {
      // Emit any buffered tool calls
      for (const tc of toolCallBuffers.values()) {
        onChunk({ type: 'tool_call_end', toolCall: tc })
      }
      onChunk({ type: 'done' })
      return
    }

    const choice = data?.choices?.[0]
    if (!choice) return

    const delta = choice.delta
    if (!delta) return

    // Text content
    if (delta.content) {
      onChunk({ type: 'text', text: delta.content })
    }

    // Tool calls (streamed incrementally)
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0
        if (tc.id) {
          // New tool call starting
          toolCallBuffers.set(idx, { id: tc.id, name: tc.function?.name || '', arguments: tc.function?.arguments || '' })
          onChunk({ type: 'tool_call_start', toolCall: toolCallBuffers.get(idx)! })
        } else if (toolCallBuffers.has(idx)) {
          // Continuation
          const buf = toolCallBuffers.get(idx)!
          if (tc.function?.arguments) buf.arguments += tc.function.arguments
          onChunk({ type: 'tool_call_delta', text: tc.function?.arguments || '' })
        }
      }
    }

    // Usage info (in final chunk for some providers)
    if (data?.usage) {
      onChunk({ type: 'done', usage: extractUsage(provider.type, data) })
    }
  }, (fullData) => {
    // Parse final aggregated response
    const toolCalls = Array.from(toolCallBuffers.values()).map(tc => ({
      id: tc.id,
      name: tc.name,
      arguments: safeParseJSON(tc.arguments),
    }))
    return {
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: fullData?.usage ? extractUsage(provider.type, fullData) : { inputTokens: 0, outputTokens: 0 },
    }
  }, provider.type)
}

// ─── Ollama Streaming (NDJSON) ───

async function streamOllama(
  provider: ProviderConfig,
  messages: LLMMessage[],
  onChunk: StreamCallback,
): Promise<LLMResponse> {
  const body = JSON.stringify({
    model: provider.model,
    messages: messages.map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) })),
    stream: true,
  })

  const baseUrl = provider.baseUrl.replace(/\/+$/, '')

  return new Promise((resolve) => {
    const url = new URL(baseUrl)
    const transport = url.protocol === 'https:' ? https : http
    const fullPath = (url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '')) + '/api/chat'

    let fullContent = ''
    let finalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
    const startTime = Date.now()

    const req = transport.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: fullPath,
      method: 'POST',
      timeout: 120000,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      let buffer = ''
      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop() || '' // keep incomplete line

        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const data = JSON.parse(line)
            if (data.message?.content) {
              fullContent += data.message.content
              onChunk({ type: 'text', text: data.message.content })
            }
            if (data.done) {
              finalUsage = extractUsage('ollama', data)
              onChunk({ type: 'done', usage: finalUsage })
            }
          } catch { /* skip malformed line */ }
        }
      })

      res.on('end', () => {
        resolve({
          content: fullContent,
          usage: finalUsage,
          durationMs: Date.now() - startTime,
        })
      })
    })

    req.on('error', (err) => {
      onChunk({ type: 'error', error: err.message })
      resolve({ content: fullContent, usage: finalUsage, error: err.message, durationMs: Date.now() - startTime })
    })

    req.on('timeout', () => {
      req.destroy()
      onChunk({ type: 'error', error: 'Request timed out' })
      resolve({ content: fullContent, usage: finalUsage, error: 'Request timed out', durationMs: Date.now() - startTime })
    })

    req.write(body)
    req.end()
  })
}

// ─── Azure OpenAI ───

async function callAzureOpenAI(provider: ProviderConfig, messages: LLMMessage[], tools?: any[]): Promise<LLMResponse> {
  const deployment = provider.model
  const apiPath = `/openai/deployments/${deployment}/chat/completions?api-version=2024-08-01-preview`

  const reqBody: any = {
    messages: messages.map(m => {
      if (typeof m.content !== 'string' || m.tool_calls || m.tool_call_id) return m
      return { role: m.role, content: m.content }
    }),
    max_completion_tokens: 4096,
  }

  if (tools && tools.length > 0) {
    reqBody.tools = tools
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'api-key': provider.apiKey || '',
    ...(provider.customHeaders || {}),
  }

  return httpRequestJSON(provider.baseUrl, apiPath, JSON.stringify(reqBody), headers, (data) => parseOpenAIResponse(data, 'azure'), 'azure')
}

// ─── Google Gemini ───

async function callGemini(provider: ProviderConfig, messages: LLMMessage[], tools?: any[]): Promise<LLMResponse> {
  const apiPath = `/v1beta/models/${provider.model}:generateContent`

  const systemMsg = messages.find(m => m.role === 'system')
  const contents = messages.filter(m => m.role !== 'system').map(m => {
    // Handle pre-formatted Gemini messages (with parts)
    if (m.parts) return { role: m.role === 'assistant' ? 'model' : 'user', parts: m.parts }
    return {
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
    }
  })

  const reqBody: any = {
    ...(systemMsg ? { systemInstruction: { parts: [{ text: typeof systemMsg.content === 'string' ? systemMsg.content : '' }] } } : {}),
    contents,
  }

  if (tools && tools.length > 0) {
    reqBody.tools = [{ functionDeclarations: tools }]
  }

  return httpRequestJSON(provider.baseUrl, apiPath, JSON.stringify(reqBody), {
    'content-type': 'application/json',
    'x-goog-api-key': provider.apiKey || '',
  }, (data) => parseGeminiResponse(data), 'gemini')
}

// ─── Response Parsers ───

function parseAnthropicResponse(data: any): Partial<LLMResponse> {
  const textParts: string[] = []
  const toolCalls: LLMResponse['toolCalls'] = []

  if (data.content && Array.isArray(data.content)) {
    for (const block of data.content) {
      if (block.type === 'text') {
        textParts.push(block.text || '')
      } else if (block.type === 'tool_use') {
        toolCalls.push({ id: block.id, name: block.name, arguments: block.input || {} })
      }
    }
  }

  if (data.error) {
    return { error: data.error.message || data.error.type }
  }

  return {
    content: textParts.join(''),
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: extractUsage('anthropic', data),
  }
}

function parseAnthropicStreamFinal(events: any[]): Partial<LLMResponse> {
  // Reconstruct from collected SSE events
  let inputTokens = 0
  let outputTokens = 0

  for (const evt of events) {
    if (evt.message?.usage?.input_tokens) inputTokens = evt.message.usage.input_tokens
    if (evt.usage?.output_tokens) outputTokens = evt.usage.output_tokens
  }

  return { usage: { inputTokens, outputTokens } }
}

function parseOpenAIResponse(data: any, providerType: string): Partial<LLMResponse> {
  const choice = data.choices?.[0]
  if (!choice) {
    // Ollama format
    if (data.message?.content) {
      return { content: data.message.content, usage: extractUsage(providerType, data) }
    }
    return { error: data.error?.message || 'No response' }
  }

  const msg = choice.message
  const toolCalls = msg?.tool_calls?.map((tc: any) => ({
    id: tc.id,
    name: tc.function?.name || '',
    arguments: safeParseJSON(tc.function?.arguments || '{}'),
  }))

  return {
    content: msg?.content || '',
    toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
    usage: extractUsage(providerType, data),
  }
}

function parseGeminiResponse(data: any): Partial<LLMResponse> {
  const candidate = data.candidates?.[0]
  if (!candidate) {
    return { error: data.error?.message || 'No response' }
  }

  const textParts: string[] = []
  const toolCalls: LLMResponse['toolCalls'] = []

  for (const part of candidate.content?.parts || []) {
    if (part.text) textParts.push(part.text)
    if (part.functionCall) {
      toolCalls.push({
        id: `gemini-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: part.functionCall.name,
        arguments: part.functionCall.args || {},
      })
    }
  }

  return {
    content: textParts.join(''),
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: extractUsage('gemini', data),
  }
}

// ─── HTTP Helpers ───

function httpRequestJSON(
  baseUrl: string,
  path: string,
  body: string,
  headers: Record<string, string>,
  parseResponse: (data: any) => Partial<LLMResponse>,
  providerType: string,
): Promise<LLMResponse> {
  return new Promise((resolve) => {
    const startTime = Date.now()
    try {
      const url = new URL(baseUrl)
      const transport = url.protocol === 'https:' ? https : http
      const fullPath = (url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '')) + path

      console.log(`[LLM] POST ${url.protocol}//${url.hostname}${fullPath}`)

      const req = transport.request({
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: fullPath,
        method: 'POST',
        timeout: 120000,
        headers: { ...headers, 'content-length': Buffer.byteLength(body) },
      }, (res) => {
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          try {
            const json = JSON.parse(data)

            if (res.statusCode && res.statusCode >= 400) {
              const errMsg = json.error?.message || json.error?.type || json.message || `HTTP ${res.statusCode}`
              resolve({ content: '', usage: { inputTokens: 0, outputTokens: 0 }, error: errMsg, durationMs: Date.now() - startTime })
              return
            }

            const parsed = parseResponse(json)
            resolve({
              content: parsed.content || '',
              toolCalls: parsed.toolCalls,
              usage: parsed.usage || { inputTokens: 0, outputTokens: 0 },
              rawResponse: json,
              error: parsed.error,
              durationMs: Date.now() - startTime,
            })
          } catch {
            resolve({ content: '', usage: { inputTokens: 0, outputTokens: 0 }, error: `Invalid response: ${data.substring(0, 100)}`, durationMs: Date.now() - startTime })
          }
        })
      })

      req.on('error', (err) => resolve({ content: '', usage: { inputTokens: 0, outputTokens: 0 }, error: err.message, durationMs: Date.now() - startTime }))
      req.on('timeout', () => { req.destroy(); resolve({ content: '', usage: { inputTokens: 0, outputTokens: 0 }, error: 'Request timed out', durationMs: Date.now() - startTime }) })

      req.write(body)
      req.end()
    } catch (err: any) {
      resolve({ content: '', usage: { inputTokens: 0, outputTokens: 0 }, error: err.message, durationMs: Date.now() - startTime })
    }
  })
}

function httpRequestSSE(
  baseUrl: string,
  path: string,
  body: string,
  headers: Record<string, string>,
  onEvent: (event: string, data: any) => void,
  parseFinal: (events: any[]) => Partial<LLMResponse>,
  providerType: string,
): Promise<LLMResponse> {
  return new Promise((resolve) => {
    const startTime = Date.now()
    const collectedEvents: any[] = []
    let fullContent = ''
    const toolCalls: Array<{ id: string; name: string; arguments: Record<string, any> }> = []
    const toolCallBuffers = new Map<string, { id: string; name: string; argStr: string }>()

    try {
      const url = new URL(baseUrl)
      const transport = url.protocol === 'https:' ? https : http
      const fullPath = (url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '')) + path

      const req = transport.request({
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: fullPath,
        method: 'POST',
        timeout: 120000,
        headers: { ...headers, 'content-length': Buffer.byteLength(body) },
      }, (res) => {
        let buffer = ''
        let rawDataSize = 0

        console.log(`[SSE] Response status: ${res.statusCode}, headers: content-type=${res.headers['content-type']}`)

        res.on('data', (chunk: Buffer) => {
          const chunkStr = chunk.toString()
          rawDataSize += chunkStr.length
          if (rawDataSize <= 500) {
            console.log(`[SSE] Raw chunk (${chunkStr.length} chars): ${chunkStr.substring(0, 200).replace(/\n/g, '\\n')}`)
          }
          buffer += chunkStr
          const parts = buffer.split('\n\n')
          buffer = parts.pop() || ''

          for (const part of parts) {
            let eventName = 'message'
            let eventData = ''

            for (const line of part.split('\n')) {
              if (line.startsWith('event: ')) eventName = line.slice(7).trim()
              else if (line.startsWith('data: ')) eventData += line.slice(6)
              else if (line.startsWith('data:')) eventData += line.slice(5)
            }

            if (!eventData.trim()) continue

            // Handle [DONE] sentinel
            if (eventData.trim() === '[DONE]') {
              onEvent(eventName, '[DONE]')
              continue
            }

            try {
              const parsed = JSON.parse(eventData)
              collectedEvents.push(parsed)
              onEvent(eventName, parsed)

              // Accumulate text from Anthropic format
              if (parsed.delta?.type === 'text_delta') {
                fullContent += parsed.delta.text || ''
              }
              // Accumulate text from OpenAI/Azure/Groq format
              if (parsed.choices?.[0]?.delta?.content) {
                fullContent += parsed.choices[0].delta.content
              }
              // Accumulate tool calls from Anthropic format
              if (parsed.content_block?.type === 'tool_use') {
                toolCallBuffers.set(parsed.content_block.id, { id: parsed.content_block.id, name: parsed.content_block.name, argStr: '' })
              }
              if (parsed.delta?.type === 'input_json_delta' && parsed.index !== undefined) {
                // Find the tool call buffer by index
                const entries = Array.from(toolCallBuffers.values())
                if (entries[parsed.index]) {
                  entries[parsed.index].argStr += parsed.delta.partial_json || ''
                }
              }
            } catch { /* skip malformed events */ }
          }
        })

        res.on('end', () => {
          console.log(`[SSE] Stream ended. Total raw data: ${rawDataSize} chars, collected events: ${collectedEvents.length}, fullContent: ${fullContent.length} chars, remaining buffer: ${buffer.length} chars`)
          if (buffer.trim()) {
            console.log(`[SSE] Remaining buffer content: ${buffer.substring(0, 300).replace(/\n/g, '\\n')}`)
          }

          // Finalize tool calls from buffers
          for (const tc of toolCallBuffers.values()) {
            toolCalls.push({ id: tc.id, name: tc.name, arguments: safeParseJSON(tc.argStr) })
          }

          const finalParsed = parseFinal(collectedEvents)

          resolve({
            content: fullContent,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            usage: finalParsed.usage || { inputTokens: 0, outputTokens: 0 },
            durationMs: Date.now() - startTime,
          })
        })
      })

      req.on('error', (err) => resolve({ content: fullContent, usage: { inputTokens: 0, outputTokens: 0 }, error: err.message, durationMs: Date.now() - startTime }))
      req.on('timeout', () => { req.destroy(); resolve({ content: fullContent, usage: { inputTokens: 0, outputTokens: 0 }, error: 'Request timed out', durationMs: Date.now() - startTime }) })

      req.write(body)
      req.end()
    } catch (err: any) {
      resolve({ content: '', usage: { inputTokens: 0, outputTokens: 0 }, error: err.message, durationMs: Date.now() - startTime })
    }
  })
}

// ─── Utility ───

function safeParseJSON(str: string): Record<string, any> {
  try {
    return JSON.parse(str || '{}')
  } catch {
    return {}
  }
}
