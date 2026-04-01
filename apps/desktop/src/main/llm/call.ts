import https from 'https'
import http from 'http'
import type { ProviderConfig } from '../store/providers.store'

interface LLMMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface LLMResponse {
  content: string
  error?: string
}

/**
 * Call an LLM provider and return the response text.
 */
export async function callLLM(
  provider: ProviderConfig,
  messages: LLMMessage[],
): Promise<LLMResponse> {
  console.log(`[LLM] Calling ${provider.type} provider "${provider.name}" (${provider.model}) at ${provider.baseUrl}`)

  let result: LLMResponse

  if (provider.type === 'anthropic') {
    result = await callAnthropic(provider, messages)
  } else if (provider.type === 'gemini') {
    result = await callGemini(provider, messages)
  } else if (provider.type === 'azure') {
    result = await callAzureOpenAI(provider, messages)
  } else {
    result = await callOpenAICompatible(provider, messages)
  }

  if (result.error) {
    console.log(`[LLM] Error: ${result.error}`)
  } else {
    console.log(`[LLM] Success: ${result.content.length} chars`)
  }

  return result
}

// ─── Anthropic (Claude) ───
async function callAnthropic(provider: ProviderConfig, messages: LLMMessage[]): Promise<LLMResponse> {
  const systemMsg = messages.find(m => m.role === 'system')
  const userMsgs = messages.filter(m => m.role !== 'system').map(m => ({
    role: m.role,
    content: m.content,
  }))

  const body = JSON.stringify({
    model: provider.model,
    max_tokens: 4096,
    system: systemMsg?.content || '',
    messages: userMsgs,
  })

  // Anthropic API is always at /v1/messages — strip any /v1 from baseUrl to avoid /v1/v1
  const baseUrl = provider.baseUrl.replace(/\/v1\/?$/, '')

  return httpRequest(baseUrl, '/v1/messages', body, {
    'x-api-key': provider.apiKey || '',
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  }, (data) => {
    if (data.content && Array.isArray(data.content)) {
      return data.content.map((c: any) => c.text || '').join('')
    }
    if (data.error) {
      return null // will be handled as error
    }
    return JSON.stringify(data)
  }, (data) => {
    return data.error?.message || data.error?.type || null
  })
}

// ─── OpenAI-compatible (OpenAI, Ollama, Groq, Custom) ───
async function callOpenAICompatible(provider: ProviderConfig, messages: LLMMessage[]): Promise<LLMResponse> {
  let apiPath: string
  if (provider.type === 'ollama') {
    apiPath = '/api/chat'
  } else if (provider.type === 'groq') {
    apiPath = '/openai/v1/chat/completions'
  } else {
    // For OpenAI and custom: if baseUrl ends with /v1, don't add /v1 again
    apiPath = provider.baseUrl.includes('/v1') ? '/chat/completions' : '/v1/chat/completions'
  }

  let reqBody: any
  if (provider.type === 'ollama') {
    reqBody = {
      model: provider.model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      stream: false,
    }
  } else {
    reqBody = {
      model: provider.model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      max_tokens: 4096,
    }
  }

  const body = JSON.stringify(reqBody)
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}),
    ...(provider.customHeaders || {}),
  }

  // Clean baseUrl for path construction
  const baseUrl = provider.baseUrl.replace(/\/v1\/?$/, '').replace(/\/+$/, '')

  return httpRequest(baseUrl, apiPath, body, headers, (data) => {
    // Ollama: { message: { content: "..." } }
    if (data.message?.content) return data.message.content
    // OpenAI: { choices: [{ message: { content: "..." } }] }
    if (data.choices?.[0]?.message?.content) return data.choices[0].message.content
    return null
  }, (data) => {
    return data.error?.message || data.error?.type || null
  })
}

// ─── Azure OpenAI ───
async function callAzureOpenAI(provider: ProviderConfig, messages: LLMMessage[]): Promise<LLMResponse> {
  // Azure uses: /openai/deployments/{deployment}/chat/completions?api-version=...
  const deployment = provider.model
  const apiPath = `/openai/deployments/${deployment}/chat/completions?api-version=2024-08-01-preview`

  const body = JSON.stringify({
    messages: messages.map(m => ({ role: m.role, content: m.content })),
    max_completion_tokens: 4096,
  })

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'api-key': provider.apiKey || '',
    ...(provider.customHeaders || {}),
  }

  return httpRequest(provider.baseUrl, apiPath, body, headers, (data) => {
    if (data.choices?.[0]?.message?.content) return data.choices[0].message.content
    return null
  }, (data) => {
    return data.error?.message || data.error?.type || null
  })
}

// ─── Google Gemini ───
async function callGemini(provider: ProviderConfig, messages: LLMMessage[]): Promise<LLMResponse> {
  const apiPath = `/v1beta/models/${provider.model}:generateContent`

  const systemMsg = messages.find(m => m.role === 'system')
  const contents = messages.filter(m => m.role !== 'system').map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }))

  const body = JSON.stringify({
    ...(systemMsg ? { systemInstruction: { parts: [{ text: systemMsg.content }] } } : {}),
    contents,
  })

  return httpRequest(provider.baseUrl, apiPath, body, {
    'content-type': 'application/json',
    'x-goog-api-key': provider.apiKey || '',
  }, (data) => {
    if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
      return data.candidates[0].content.parts[0].text
    }
    return null
  }, (data) => {
    return data.error?.message || null
  })
}

// ─── HTTP helper ───
function httpRequest(
  baseUrl: string,
  path: string,
  body: string,
  headers: Record<string, string>,
  extractContent: (data: any) => string | null,
  extractError: (data: any) => string | null,
): Promise<LLMResponse> {
  return new Promise((resolve) => {
    try {
      const url = new URL(baseUrl)
      const transport = url.protocol === 'https:' ? https : http

      // Combine base path with API path
      const fullPath = (url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '')) + path

      console.log(`[LLM] POST ${url.protocol}//${url.hostname}:${url.port || (url.protocol === 'https:' ? 443 : 80)}${fullPath}`)
      console.log(`[LLM] Body size: ${Buffer.byteLength(body)} bytes`)

      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: fullPath,
        method: 'POST',
        timeout: 90000,
        headers: {
          ...headers,
          'content-length': Buffer.byteLength(body),
        },
      }

      const req = transport.request(options, (res) => {
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          console.log(`[LLM] Response status: ${res.statusCode}, size: ${data.length} chars`)

          try {
            const json = JSON.parse(data)

            if (res.statusCode && res.statusCode >= 400) {
              const errMsg = extractError(json) || json.message || `HTTP ${res.statusCode}`
              console.log(`[LLM] API error: ${errMsg}`)
              resolve({ content: '', error: errMsg })
              return
            }

            const content = extractContent(json)
            if (content) {
              resolve({ content })
            } else {
              const errMsg = extractError(json)
              if (errMsg) {
                resolve({ content: '', error: errMsg })
              } else {
                console.log(`[LLM] Unexpected response shape:`, JSON.stringify(json).substring(0, 300))
                resolve({ content: '', error: `Unexpected response format` })
              }
            }
          } catch {
            console.log(`[LLM] Non-JSON response:`, data.substring(0, 300))
            resolve({ content: '', error: `Invalid response: ${data.substring(0, 100)}` })
          }
        })
      })

      req.on('error', (err) => {
        console.log(`[LLM] Connection error: ${err.message}`)
        resolve({ content: '', error: `Connection error: ${err.message}` })
      })

      req.on('timeout', () => {
        req.destroy()
        console.log(`[LLM] Request timed out`)
        resolve({ content: '', error: 'Request timed out (90s)' })
      })

      req.write(body)
      req.end()
    } catch (err: any) {
      console.log(`[LLM] Exception: ${err.message}`)
      resolve({ content: '', error: err.message })
    }
  })
}
