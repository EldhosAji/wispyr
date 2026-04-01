/**
 * Cost Tracker — tracks token usage and estimated cost per task/session.
 *
 * Works with any LLM provider by extracting usage data from each response.
 * Pricing is approximate and configurable.
 */

// ─── Pricing (USD per 1M tokens) ───

interface ModelPricing {
  input: number   // per 1M input tokens
  output: number  // per 1M output tokens
}

const DEFAULT_PRICING: ModelPricing = { input: 1.0, output: 2.0 }

const PRICING: Record<string, ModelPricing> = {
  // Anthropic
  'claude-opus-4-6':       { input: 15.0, output: 75.0 },
  'claude-sonnet-4-6':     { input: 3.0, output: 15.0 },
  'claude-haiku-4-5':      { input: 0.8, output: 4.0 },
  // OpenAI
  'gpt-4o':                { input: 2.5, output: 10.0 },
  'gpt-4o-mini':           { input: 0.15, output: 0.6 },
  'gpt-4-turbo':           { input: 10.0, output: 30.0 },
  'gpt-3.5-turbo':         { input: 0.5, output: 1.5 },
  // Gemini
  'gemini-2.0-flash':      { input: 0.1, output: 0.4 },
  'gemini-2.0-pro':        { input: 1.25, output: 5.0 },
  'gemini-1.5-pro':        { input: 1.25, output: 5.0 },
  // Groq (hosted, much cheaper)
  'llama-3.1-70b-versatile': { input: 0.59, output: 0.79 },
  'llama-3.1-8b-instant':   { input: 0.05, output: 0.08 },
  'mixtral-8x7b-32768':     { input: 0.24, output: 0.24 },
  // Ollama (local, free)
  'ollama':                  { input: 0, output: 0 },
}

// ─── Types ───

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
}

export interface CostEntry {
  timestamp: string
  model: string
  provider: string
  usage: TokenUsage
  costUSD: number
  durationMs: number
}

export interface TaskCostSummary {
  taskId: string
  totalInputTokens: number
  totalOutputTokens: number
  totalCostUSD: number
  totalDurationMs: number
  apiCalls: number
  entries: CostEntry[]
}

// ─── Tracker ───

const _taskCosts = new Map<string, TaskCostSummary>()
let _sessionTotalCostUSD = 0
let _sessionTotalInputTokens = 0
let _sessionTotalOutputTokens = 0

export function trackUsage(
  taskId: string,
  model: string,
  providerType: string,
  usage: TokenUsage,
  durationMs: number,
): CostEntry {
  const costUSD = calculateCost(model, providerType, usage)

  const entry: CostEntry = {
    timestamp: new Date().toISOString(),
    model,
    provider: providerType,
    usage,
    costUSD,
    durationMs,
  }

  // Update task summary
  let summary = _taskCosts.get(taskId)
  if (!summary) {
    summary = {
      taskId,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUSD: 0,
      totalDurationMs: 0,
      apiCalls: 0,
      entries: [],
    }
    _taskCosts.set(taskId, summary)
  }

  summary.totalInputTokens += usage.inputTokens
  summary.totalOutputTokens += usage.outputTokens
  summary.totalCostUSD += costUSD
  summary.totalDurationMs += durationMs
  summary.apiCalls += 1
  summary.entries.push(entry)

  // Update session totals
  _sessionTotalCostUSD += costUSD
  _sessionTotalInputTokens += usage.inputTokens
  _sessionTotalOutputTokens += usage.outputTokens

  return entry
}

export function getTaskCost(taskId: string): TaskCostSummary | null {
  return _taskCosts.get(taskId) || null
}

export function getSessionCost(): { totalCostUSD: number; totalInputTokens: number; totalOutputTokens: number } {
  return {
    totalCostUSD: _sessionTotalCostUSD,
    totalInputTokens: _sessionTotalInputTokens,
    totalOutputTokens: _sessionTotalOutputTokens,
  }
}

export function resetTaskCost(taskId: string): void {
  _taskCosts.delete(taskId)
}

// ─── Usage Extraction (provider-specific response parsing) ───

/** Extract token usage from an LLM response based on provider type */
export function extractUsage(providerType: string, responseData: any): TokenUsage {
  switch (providerType) {
    case 'anthropic':
      return {
        inputTokens: responseData?.usage?.input_tokens || 0,
        outputTokens: responseData?.usage?.output_tokens || 0,
      }

    case 'openai':
    case 'groq':
    case 'azure':
      return {
        inputTokens: responseData?.usage?.prompt_tokens || 0,
        outputTokens: responseData?.usage?.completion_tokens || 0,
      }

    case 'gemini':
      return {
        inputTokens: responseData?.usageMetadata?.promptTokenCount || 0,
        outputTokens: responseData?.usageMetadata?.candidatesTokenCount || 0,
      }

    case 'ollama':
      return {
        inputTokens: responseData?.prompt_eval_count || 0,
        outputTokens: responseData?.eval_count || 0,
      }

    default:
      // Try common patterns
      if (responseData?.usage) {
        return {
          inputTokens: responseData.usage.prompt_tokens || responseData.usage.input_tokens || 0,
          outputTokens: responseData.usage.completion_tokens || responseData.usage.output_tokens || 0,
        }
      }
      return { inputTokens: 0, outputTokens: 0 }
  }
}

// ─── Internal ───

function calculateCost(model: string, providerType: string, usage: TokenUsage): number {
  // Ollama is always free (local)
  if (providerType === 'ollama') return 0

  // Try exact model match first
  let pricing = PRICING[model]

  // Try partial match (e.g. "claude-opus-4-6" matches "claude-opus-4-6[1m]")
  if (!pricing) {
    for (const [key, p] of Object.entries(PRICING)) {
      if (model.startsWith(key)) {
        pricing = p
        break
      }
    }
  }

  if (!pricing) pricing = DEFAULT_PRICING

  const inputCost = (usage.inputTokens / 1_000_000) * pricing.input
  const outputCost = (usage.outputTokens / 1_000_000) * pricing.output
  return inputCost + outputCost
}

/** Format cost for display */
export function formatCost(costUSD: number): string {
  if (costUSD === 0) return 'Free'
  if (costUSD < 0.001) return '<$0.001'
  if (costUSD < 0.01) return `$${costUSD.toFixed(4)}`
  if (costUSD < 1) return `$${costUSD.toFixed(3)}`
  return `$${costUSD.toFixed(2)}`
}

/** Format token count for display */
export function formatTokens(count: number): string {
  if (count < 1000) return `${count}`
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}K`
  return `${(count / 1_000_000).toFixed(2)}M`
}
