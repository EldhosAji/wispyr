import { useState, useEffect, useRef, useCallback } from 'react'
import { Send, FolderOpen, Zap, Square, CheckCircle, XCircle, Clock, Loader, AlertTriangle, Shield, ChevronDown, ChevronRight, Copy, FileText, MessageSquare, DollarSign, Cpu } from 'lucide-react'

// ─── Types ───

interface Step {
  id: string
  title: string
  description: string
  skills: string[]
  permissionLevel: string
  status: string
  startedAt?: string
  completedAt?: string
  log?: string
  result?: string
  error?: string
}

interface Plan {
  id: string
  taskId: string
  task: string
  folder: string
  steps: Step[]
}

interface PermissionReq {
  id: string
  taskId: string
  stepId: string
  action: string
  level: string
  humanDescription: string
  details: any
}

interface StreamEvent {
  taskId: string
  type: 'thinking' | 'text_delta' | 'text_done' | 'tool_start' | 'tool_result' | 'cost_update' | 'error' | 'task_complete' | 'compacting' | 'skill_generating'
  text?: string
  toolCall?: { id: string; name: string; arguments: Record<string, any> }
  toolResult?: { toolCallId: string; name: string; result: { success: boolean; log: string; result: string; error?: string }; permissionLevel: string }
  cost?: { totalInputTokens: number; totalOutputTokens: number; totalCostUSD: number; apiCalls: number }
  error?: string
}

interface ChatEntry {
  id: string
  type: 'user' | 'assistant' | 'tool' | 'error' | 'status'
  content: string
  toolCall?: { id: string; name: string; arguments: Record<string, any> }
  toolResult?: StreamEvent['toolResult']
  timestamp: string
  isStreaming?: boolean
}

interface CostInfo {
  totalInputTokens: number
  totalOutputTokens: number
  totalCostUSD: number
  apiCalls: number
}

interface HomeProps {
  agentStatus: string
  currentTaskId: string | null
}

// ─── Component ───

export function Home({ agentStatus, currentTaskId }: HomeProps) {
  const [input, setInput] = useState('')
  const [folder, setFolder] = useState<string | null>(null)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [steps, setSteps] = useState<Step[]>([])
  const [permissionReq, setPermissionReq] = useState<PermissionReq | null>(null)
  const [countdown, setCountdown] = useState(0)
  const [confirmText, setConfirmText] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null)
  const [agentMode, setAgentMode] = useState<'agent' | 'legacy' | null>(null)
  const feedRef = useRef<HTMLDivElement>(null)

  // Phase A+B: New state
  const [chatLog, setChatLog] = useState<ChatEntry[]>([])
  const [streamingText, setStreamingText] = useState('')
  const [isThinking, setIsThinking] = useState(false)
  const [taskCost, setTaskCost] = useState<CostInfo | null>(null)
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set())

  // Streaming text accumulator ref (avoids stale closures)
  const streamingTextRef = useRef('')
  // Ref to track active task ID inside event listeners (avoids stale closures)
  const activeTaskIdRef = useRef<string | null>(null)
  // Keep ref in sync with state
  useEffect(() => { activeTaskIdRef.current = activeTaskId }, [activeTaskId])

  // ─── Subscribe to streaming events (once, not per-taskId) ───
  useEffect(() => {
    console.log('[Home] Setting up stream listener')
    const unsubStream = window.wispyr.agent.onStream((event: StreamEvent) => {
      console.log(`[Home] Stream event received: type=${event.type}, taskId=${event.taskId}, activeRef=${activeTaskIdRef.current}, text=${event.text?.substring(0, 50) || ''}`)
      if (!activeTaskIdRef.current || event.taskId !== activeTaskIdRef.current) {
        console.log(`[Home] SKIPPED: taskId mismatch (event=${event.taskId}, ref=${activeTaskIdRef.current})`)
        return
      }

      switch (event.type) {
        case 'thinking':
          setIsThinking(true)
          break

        case 'text_delta':
          setIsThinking(false)
          streamingTextRef.current += event.text || ''
          setStreamingText(streamingTextRef.current)
          break

        case 'text_done':
          setIsThinking(false)
          const finalText = event.text || streamingTextRef.current
          if (finalText.trim()) {
            setChatLog(prev => [...prev, {
              id: `msg-${Date.now()}`,
              type: 'assistant',
              content: finalText,
              timestamp: new Date().toISOString(),
            }])
          }
          streamingTextRef.current = ''
          setStreamingText('')
          break

        case 'tool_start':
          setIsThinking(false)
          // Flush any pending streaming text
          if (streamingTextRef.current.trim()) {
            const pendingText = streamingTextRef.current
            setChatLog(prev => [...prev, {
              id: `msg-${Date.now()}`,
              type: 'assistant',
              content: pendingText,
              timestamp: new Date().toISOString(),
            }])
            streamingTextRef.current = ''
            setStreamingText('')
          }
          if (event.toolCall) {
            setChatLog(prev => [...prev, {
              id: `tool-${event.toolCall!.id}`,
              type: 'tool',
              content: `Calling: ${event.toolCall!.name}`,
              toolCall: event.toolCall,
              timestamp: new Date().toISOString(),
              isStreaming: true,
            }])
          }
          break

        case 'tool_result':
          if (event.toolResult) {
            setChatLog(prev => prev.map(entry =>
              entry.id === `tool-${event.toolResult!.toolCallId}`
                ? { ...entry, isStreaming: false, toolResult: event.toolResult, content: event.toolResult!.result.result || event.toolResult!.result.log.substring(0, 100) }
                : entry
            ))
          }
          break

        case 'cost_update':
          if (event.cost) setTaskCost(event.cost)
          break

        case 'error':
          setIsThinking(false)
          setChatLog(prev => [...prev, {
            id: `err-${Date.now()}`,
            type: 'error',
            content: event.error || 'Unknown error',
            timestamp: new Date().toISOString(),
          }])
          break

        case 'task_complete':
          setIsThinking(false)
          setIsSubmitting(false)
          // Flush any pending streaming text to chatLog
          if (streamingTextRef.current.trim() || (event.text && event.text.trim())) {
            const finalText = streamingTextRef.current.trim() || event.text || ''
            if (finalText) {
              setChatLog(prev => [...prev, {
                id: `msg-${Date.now()}`,
                type: 'assistant',
                content: finalText,
                timestamp: new Date().toISOString(),
              }])
            }
            streamingTextRef.current = ''
            setStreamingText('')
          }
          if (event.cost) setTaskCost(event.cost)
          // Don't clear activeTaskId — keep it for follow-ups
          break

        case 'compacting':
          setChatLog(prev => [...prev, {
            id: `status-${Date.now()}`,
            type: 'status',
            content: 'Compacting conversation history...',
            timestamp: new Date().toISOString(),
          }])
          break

        case 'skill_generating':
          setIsThinking(true)
          setChatLog(prev => {
            // Update existing skill_generating status or add new one
            const existing = prev.findIndex(e => e.id === 'skill-gen-status')
            if (existing >= 0) {
              const updated = [...prev]
              updated[existing] = { ...updated[existing], content: event.text || 'Generating new skill...' }
              return updated
            }
            return [...prev, {
              id: 'skill-gen-status',
              type: 'status',
              content: event.text || 'Generating new skill...',
              timestamp: new Date().toISOString(),
            }]
          })
          break
      }
    })

    return () => { unsubStream() }
  }, []) // Subscribe once — uses refs to avoid stale closures

  // ─── Permission requests ───
  useEffect(() => {
    const unsubPermission = window.wispyr.permission.onRequest((req: PermissionReq) => {
      setPermissionReq(req)
      setConfirmText('')
      if (req.level === 'destructive') setCountdown(3)
    })
    return () => { unsubPermission() }
  }, [])

  // ─── Legacy mode: poll for step updates ───
  useEffect(() => {
    if (!activeTaskId || agentMode !== 'legacy') return
    const interval = setInterval(async () => {
      try {
        const t = await window.wispyr.tasks.get(activeTaskId)
        if (!t) return
        if (t.steps?.length > 0) setSteps(t.steps)
        if (t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled') {
          setIsSubmitting(false)
        }
      } catch { /* ignore */ }
    }, 800)
    return () => clearInterval(interval)
  }, [activeTaskId, agentMode])

  // Countdown timer
  useEffect(() => {
    if (countdown > 0) {
      const timer = setTimeout(() => setCountdown(countdown - 1), 1000)
      return () => clearTimeout(timer)
    }
  }, [countdown])

  // Auto-scroll
  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight
    }
  }, [chatLog, streamingText, steps, permissionReq, isThinking])

  // ─── Handlers ───

  const handlePickFolder = async () => {
    const selected = await window.wispyr.fs.pickFolder()
    if (selected) setFolder(selected)
  }

  const handleSubmit = async () => {
    if (!input.trim() || !folder) return
    const message = input.trim()
    setInput('')
    setIsSubmitting(true)
    setIsThinking(true)

    // Check if this is a follow-up
    const isFollowUp = activeTaskId && agentMode === 'agent'

    const userEntry: ChatEntry = {
      id: `user-${Date.now()}`,
      type: 'user',
      content: message,
      timestamp: new Date().toISOString(),
    }

    try {
      if (isFollowUp) {
        // Multi-turn follow-up — append to existing chat
        setChatLog(prev => [...prev, userEntry])
        await window.wispyr.agent.followup(activeTaskId!, message)
      } else {
        // New task — reset chat with just the user message
        setPlan(null)
        setSteps([])
        setChatLog([userEntry])
        setTaskCost(null)
        streamingTextRef.current = ''
        setStreamingText('')

        const result = await window.wispyr.agent.run(message, folder)
        // Set ref IMMEDIATELY so the stream listener can match events
        activeTaskIdRef.current = result.taskId
        setActiveTaskId(result.taskId)

        if (result.mode === 'legacy' && result.plan) {
          // Legacy mode: show plan for approval
          setAgentMode('legacy')
          setPlan(result.plan)
          setSteps(result.plan.steps || [])
          setIsThinking(false)
          setIsSubmitting(false)
        } else {
          // Agent mode: streaming events will arrive via onStream
          setAgentMode('agent')
        }
      }
    } catch (err: any) {
      setChatLog(prev => [...prev, {
        id: `err-${Date.now()}`,
        type: 'error',
        content: `Failed: ${err.message}`,
        timestamp: new Date().toISOString(),
      }])
      setIsThinking(false)
      setIsSubmitting(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  const handleApprovePlan = async () => {
    if (!plan) return
    setPlan(null)
    await window.wispyr.plan.approve(plan.taskId, steps)
    setIsSubmitting(true)
  }

  const handleRejectPlan = async () => {
    if (!plan) return
    await window.wispyr.plan.reject(plan.taskId)
    setPlan(null)
    setSteps([])
    setActiveTaskId(null)
    setAgentMode(null)
  }

  const handleCancelTask = () => {
    if (activeTaskId) {
      window.wispyr.agent.cancel(activeTaskId)
      setActiveTaskId(null)
      setAgentMode(null)
      setIsSubmitting(false)
      setIsThinking(false)
    }
  }

  const handleNewTask = () => {
    setActiveTaskId(null)
    setAgentMode(null)
    setChatLog([])
    setSteps([])
    setPlan(null)
    setTaskCost(null)
    setStreamingText('')
    streamingTextRef.current = ''
  }

  const handlePermissionRespond = (approved: boolean) => {
    if (!permissionReq) return
    window.wispyr.permission.respond(permissionReq.stepId, approved, false)
    setPermissionReq(null)
    setCountdown(0)
    setConfirmText('')
  }

  const toggleToolExpanded = (id: string) => {
    setExpandedTools(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
  }

  const isRunning = isSubmitting || isThinking
  const hasActivity = chatLog.length > 0 || plan || steps.length > 0 || isThinking
  const canFollowUp = activeTaskId && agentMode === 'agent' && !isThinking

  // ─── Render Helpers ───

  const getPermBadge = (level: string) => {
    switch (level) {
      case 'read_only': return <span className="badge badge-success">READ</span>
      case 'write': return <span className="badge badge-warning">WRITE</span>
      case 'destructive': return <span className="badge badge-danger">DESTRUCTIVE</span>
      case 'system': return <span className="badge badge-purple">SYSTEM</span>
      default: return <span className="badge badge-muted">{level}</span>
    }
  }

  const formatCost = (cost: number) => {
    if (cost === 0) return 'Free'
    if (cost < 0.001) return '<$0.001'
    if (cost < 0.01) return `$${cost.toFixed(4)}`
    return `$${cost.toFixed(3)}`
  }

  const formatTokens = (n: number) => {
    if (n < 1000) return `${n}`
    if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`
    return `${(n / 1_000_000).toFixed(2)}M`
  }

  // ─── Render ───

  return (
    <div className="page">
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
        {/* Chat/Task feed */}
        <div className="task-feed" ref={feedRef} style={{ flex: 1 }}>
          {!hasActivity && (
            <div className="empty-state">
              <Zap className="icon" size={48} />
              <h3>What would you like to do?</h3>
              <p>
                Describe a task in plain language. Wispyr will use AI tools
                to execute it step by step. You can send follow-up messages
                to refine or continue.
              </p>
            </div>
          )}

          {/* Chat log (agent mode) */}
          {agentMode === 'agent' && chatLog.map(entry => (
            <div key={entry.id} className={`chat-entry chat-${entry.type}`}>
              {entry.type === 'user' && (
                <div className="card" style={{ borderColor: 'var(--accent)', borderLeft: '3px solid var(--accent)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-1)' }}>
                    <MessageSquare size={14} style={{ color: 'var(--accent)' }} />
                    <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>You</span>
                  </div>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{entry.content}</div>
                </div>
              )}

              {entry.type === 'assistant' && (
                <div className="card" style={{ borderLeft: '3px solid var(--success)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-1)' }}>
                    <Cpu size={14} style={{ color: 'var(--success)' }} />
                    <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>Wispyr</span>
                    {entry.content.length > 20 && (
                      <button type="button" className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto', padding: '2px 6px' }} onClick={() => copyToClipboard(entry.content)} title="Copy">
                        <Copy size={10} />
                      </button>
                    )}
                  </div>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{entry.content}</div>
                </div>
              )}

              {entry.type === 'tool' && (
                <div className={`step-card ${entry.toolResult ? (entry.toolResult.result.success ? 'success' : 'error') : 'running'}`}>
                  <div className="step-header" style={{ cursor: 'pointer' }} onClick={() => toggleToolExpanded(entry.id)}>
                    {expandedTools.has(entry.id) ? <ChevronDown size={14} style={{ flexShrink: 0, color: 'var(--text-muted)' }} /> : <ChevronRight size={14} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />}
                    {entry.isStreaming
                      ? <Loader size={16} style={{ color: 'var(--accent)', animation: 'spin 1s linear infinite', flexShrink: 0 }} />
                      : entry.toolResult?.result.success
                        ? <CheckCircle size={16} style={{ color: 'var(--success)', flexShrink: 0 }} />
                        : <XCircle size={16} style={{ color: 'var(--danger)', flexShrink: 0 }} />
                    }
                    <span className="step-title">{entry.toolCall?.name || 'Tool'}</span>
                    {entry.toolResult && getPermBadge(entry.toolResult.permissionLevel)}
                  </div>

                  {/* Tool arguments */}
                  {expandedTools.has(entry.id) && entry.toolCall?.arguments && (
                    <div style={{ marginTop: 'var(--space-2)' }}>
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginBottom: 'var(--space-1)' }}>Arguments:</div>
                      <div className="step-log" style={{ maxHeight: '150px' }}>
                        {JSON.stringify(entry.toolCall.arguments, null, 2)}
                      </div>
                    </div>
                  )}

                  {/* Tool result */}
                  {expandedTools.has(entry.id) && entry.toolResult && (
                    <div style={{ marginTop: 'var(--space-2)' }}>
                      <div className="step-log" style={{ maxHeight: '300px', position: 'relative' }}>
                        {entry.toolResult.result.log}
                        <button type="button" className="btn btn-ghost btn-sm" style={{ position: 'absolute', top: '4px', right: '4px', padding: '2px 6px' }} onClick={(e) => { e.stopPropagation(); copyToClipboard(entry.toolResult!.result.log) }} title="Copy output">
                          <Copy size={10} />
                        </button>
                      </div>
                      {entry.toolResult.result.error && (
                        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--danger)', marginTop: 'var(--space-1)' }}>{entry.toolResult.result.error}</div>
                      )}
                    </div>
                  )}

                  {/* Collapsed result preview */}
                  {!expandedTools.has(entry.id) && entry.toolResult && (
                    <div style={{ fontSize: 'var(--text-xs)', color: entry.toolResult.result.success ? 'var(--text-secondary)' : 'var(--danger)', marginTop: 'var(--space-1)', paddingLeft: '30px' }}>
                      {entry.toolResult.result.success ? entry.toolResult.result.result : entry.toolResult.result.error}
                    </div>
                  )}
                </div>
              )}

              {entry.type === 'error' && (
                <div className="card" style={{ borderColor: 'var(--danger)', borderLeft: '3px solid var(--danger)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                    <AlertTriangle size={14} style={{ color: 'var(--danger)' }} />
                    <span style={{ color: 'var(--danger)' }}>{entry.content}</span>
                  </div>
                </div>
              )}

              {entry.type === 'status' && (
                <div style={{ textAlign: 'center', fontSize: 'var(--text-xs)', color: 'var(--text-muted)', padding: 'var(--space-2)' }}>
                  {entry.content}
                </div>
              )}
            </div>
          ))}

          {/* Streaming text (in progress) */}
          {agentMode === 'agent' && streamingText && (
            <div className="card" style={{ borderLeft: '3px solid var(--success)', opacity: 0.9 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-1)' }}>
                <Loader size={14} style={{ color: 'var(--success)', animation: 'spin 1s linear infinite' }} />
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>Wispyr</span>
              </div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{streamingText}<span className="cursor-blink">|</span></div>
            </div>
          )}

          {/* Thinking indicator */}
          {isThinking && !streamingText && (
            <div className="card" style={{ borderColor: 'var(--accent)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <Loader size={16} style={{ color: 'var(--accent)', animation: 'spin 1s linear infinite' }} />
                <span>Thinking...</span>
              </div>
            </div>
          )}

          {/* Legacy mode: Plan Preview */}
          {agentMode === 'legacy' && plan && (
            <div className="plan-preview">
              <div className="plan-header">Plan for: &ldquo;{plan.task}&rdquo;</div>
              {plan.steps.map((step, i) => (
                <div className="plan-step" key={step.id}>
                  <div className="plan-step-num">{i + 1}</div>
                  <div className="plan-step-body">
                    <div className="plan-step-title">{step.title}</div>
                    <div className="plan-step-meta">
                      {step.description} &middot; {getPermBadge(step.permissionLevel)}
                    </div>
                  </div>
                </div>
              ))}
              <div className="plan-actions">
                <button type="button" className="btn btn-primary" onClick={handleApprovePlan}>Start</button>
                <button type="button" className="btn btn-secondary" onClick={handleRejectPlan}>Cancel</button>
                <div className="plan-meta">{plan.steps.length} steps &middot; Folder: {plan.folder}</div>
              </div>
            </div>
          )}

          {/* Legacy mode: Step Cards */}
          {agentMode === 'legacy' && !plan && steps.length > 0 && steps.map((step, i) => {
            const getStepIcon = (status: string) => {
              switch (status) {
                case 'running': return <Loader size={16} style={{ color: 'var(--accent)', animation: 'spin 1s linear infinite', flexShrink: 0 }} />
                case 'success': return <CheckCircle size={16} style={{ color: 'var(--success)', flexShrink: 0 }} />
                case 'error': return <XCircle size={16} style={{ color: 'var(--danger)', flexShrink: 0 }} />
                case 'skipped': return <XCircle size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                default: return <Clock size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
              }
            }
            return (
              <div className={`step-card ${step.status}`} key={step.id}>
                <div className="step-header">
                  {getStepIcon(step.status)}
                  <span className="step-title">Step {i + 1}: {step.title}</span>
                  {getPermBadge(step.permissionLevel)}
                </div>
                {step.result && step.status === 'success' && (
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginTop: 'var(--space-1)', paddingLeft: '30px' }}>{step.result}</div>
                )}
                {step.error && (
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--danger)', marginTop: 'var(--space-1)', paddingLeft: '30px' }}>{step.error}</div>
                )}
              </div>
            )
          })}

          {/* Permission Modal */}
          {permissionReq && (
            <div className={`permission-card ${permissionReq.level === 'destructive' ? 'destructive' : ''} ${permissionReq.level === 'system' ? 'system' : ''}`}>
              <div className="permission-header">
                <Shield size={16} style={{ color: permissionReq.level === 'destructive' ? 'var(--danger)' : permissionReq.level === 'system' ? 'var(--purple)' : 'var(--warning)' }} />
                <span className="permission-title">Permission Required</span>
                {getPermBadge(permissionReq.level)}
              </div>
              <div className="permission-details">{permissionReq.humanDescription}</div>
              {permissionReq.level === 'system' && (
                <div className="permission-confirm-input">
                  <label>Type CONFIRM to proceed:</label>
                  <input className="input" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder="Type CONFIRM" />
                </div>
              )}
              <div className="permission-actions">
                <button type="button" className="btn btn-primary" onClick={() => handlePermissionRespond(true)}
                  disabled={(permissionReq.level === 'destructive' && countdown > 0) || (permissionReq.level === 'system' && confirmText !== 'CONFIRM')}>
                  {permissionReq.level === 'destructive' && countdown > 0 ? `Allow once (${countdown}s)` : 'Allow once'}
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => handlePermissionRespond(false)}>Deny</button>
                <button type="button" className="kill-switch" onClick={handleCancelTask}><Square size={10} /> Kill Agent</button>
              </div>
            </div>
          )}
        </div>

        {/* Cost bar (shown when we have cost data) */}
        {taskCost && taskCost.apiCalls > 0 && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
            padding: 'var(--space-1) var(--space-4)',
            fontSize: 'var(--text-xs)', color: 'var(--text-muted)',
            borderTop: '1px solid var(--border)',
            fontFamily: 'var(--font-mono)',
          }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <DollarSign size={10} /> {formatCost(taskCost.totalCostUSD)}
            </span>
            <span>{formatTokens(taskCost.totalInputTokens)} in / {formatTokens(taskCost.totalOutputTokens)} out</span>
            <span>{taskCost.apiCalls} API calls</span>
            {canFollowUp && (
              <button type="button" className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto', fontSize: 'var(--text-xs)' }} onClick={handleNewTask}>
                New Task
              </button>
            )}
          </div>
        )}

        {/* Input area */}
        <div style={{ padding: 'var(--space-4)', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: 'var(--space-3)' }}>
            <div className="folder-selector" onClick={handlePickFolder} style={{ width: 'fit-content' }}>
              <FolderOpen className="icon" size={14} />
              <span>{folder || 'Select working folder...'}</span>
            </div>
            {isRunning && (
              <button type="button" className="kill-switch" onClick={handleCancelTask}>
                <Square size={10} /> Stop
              </button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'flex-end' }}>
            <textarea
              className="task-input"
              placeholder={canFollowUp ? 'Send a follow-up message... (Shift+Enter for newline)' : 'Describe your task... (Shift+Enter for newline)'}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={2}
              disabled={isThinking}
            />
            <button type="button" className="btn btn-primary btn-lg" onClick={handleSubmit} disabled={!input.trim() || !folder || isThinking}
              style={{ height: '48px', flexShrink: 0 }} aria-label="Send">
              <Send size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
