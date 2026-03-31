import { useState, useEffect, useRef } from 'react'
import { Send, FolderOpen, Zap, Square, CheckCircle, XCircle, Clock, Loader, AlertTriangle, Shield, ChevronDown, ChevronRight, Copy, FileText } from 'lucide-react'

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

interface HomeProps {
  agentStatus: string
  currentTaskId: string | null
}

export function Home({ agentStatus, currentTaskId }: HomeProps) {
  const [task, setTask] = useState('')
  const [folder, setFolder] = useState<string | null>(null)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [steps, setSteps] = useState<Step[]>([])
  const [permissionReq, setPermissionReq] = useState<PermissionReq | null>(null)
  const [taskResult, setTaskResult] = useState<any>(null)
  const [countdown, setCountdown] = useState(0)
  const [confirmText, setConfirmText] = useState('')
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set())
  const [showSummary, setShowSummary] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null)
  const feedRef = useRef<HTMLDivElement>(null)

  // Listen for permission requests (these are IPC events during execution)
  useEffect(() => {
    const unsubPermission = window.wispyr.permission.onRequest((req: PermissionReq) => {
      setPermissionReq(req)
      setConfirmText('')
      if (req.level === 'destructive') setCountdown(3)
    })
    return () => { unsubPermission() }
  }, [])

  // Poll for step updates during execution
  useEffect(() => {
    if (!activeTaskId) return
    const interval = setInterval(async () => {
      try {
        const t = await window.wispyr.tasks.get(activeTaskId)
        if (!t) return

        if (t.steps && t.steps.length > 0) {
          setSteps(t.steps)
          // Auto-expand running/completed steps
          const expanded = new Set(expandedSteps)
          for (const s of t.steps) {
            if (s.status === 'running' || s.status === 'success' || s.status === 'error') {
              expanded.add(s.id)
            }
          }
          setExpandedSteps(expanded)
        }

        if (t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled') {
          setTaskResult({
            taskId: activeTaskId,
            success: t.status === 'completed',
            steps: t.steps,
            startedAt: t.createdAt,
            completedAt: t.completedAt,
            error: t.error,
            summary: buildSummary(t),
          })
          setShowSummary(true)
          setActiveTaskId(null) // Stop polling
          if (t.steps) {
            setExpandedSteps(new Set(t.steps.map((s: Step) => s.id)))
          }
        }
      } catch { /* ignore */ }
    }, 800)
    return () => clearInterval(interval)
  }, [activeTaskId])

  // Countdown timer for destructive permissions
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
  }, [steps, permissionReq, taskResult])

  function buildSummary(t: any): string {
    const completed = t.steps?.filter((s: Step) => s.status === 'success').length || 0
    const skipped = t.steps?.filter((s: Step) => s.status === 'skipped').length || 0
    const errors = t.steps?.filter((s: Step) => s.status === 'error').length || 0
    const lines = [
      `Task: "${t.description}"`,
      `Folder: ${t.folder}`,
      `Steps: ${completed} completed, ${skipped} skipped, ${errors} errors, ${t.steps?.length || 0} total`,
      '',
      '── Results ──',
    ]
    for (const s of (t.steps || [])) {
      const icon = s.status === 'success' ? '✓' : s.status === 'skipped' ? '⊘' : '✗'
      lines.push(`${icon} ${s.title}: ${s.result || s.status}`)
    }
    return lines.join('\n')
  }

  const handlePickFolder = async () => {
    const selected = await window.wispyr.fs.pickFolder()
    if (selected) setFolder(selected)
  }

  const handleSubmit = async () => {
    if (!task.trim() || !folder) return
    setPlan(null)
    setSteps([])
    setTaskResult(null)
    setPermissionReq(null)
    setExpandedSteps(new Set())
    setShowSummary(false)
    setIsSubmitting(true)

    try {
      // agent:run now returns the plan directly (after LLM call)
      const result = await window.wispyr.agent.run(task, folder)
      setTask('')

      if (result.plan) {
        // Show the plan for approval
        setPlan(result.plan)
        setSteps(result.plan.steps || [])
        setActiveTaskId(result.taskId)
      }
    } catch (err: any) {
      console.error('Failed to run task:', err)
    } finally {
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
    const taskId = plan.taskId
    setPlan(null) // Hide plan preview, show step cards
    await window.wispyr.plan.approve(taskId, steps)
    setActiveTaskId(taskId) // Start polling for execution progress
  }

  const handleRejectPlan = async () => {
    if (!plan) return
    await window.wispyr.plan.reject(plan.taskId)
    setPlan(null)
    setSteps([])
    setActiveTaskId(null)
  }

  const handleCancelTask = () => {
    if (activeTaskId) {
      window.wispyr.agent.cancel(activeTaskId)
      setActiveTaskId(null)
    }
  }

  const handlePermissionRespond = (approved: boolean) => {
    if (!permissionReq) return
    window.wispyr.permission.respond(permissionReq.stepId, approved, false)
    setPermissionReq(null)
    setCountdown(0)
    setConfirmText('')
  }

  const toggleStepExpanded = (stepId: string) => {
    setExpandedSteps((prev) => {
      const next = new Set(prev)
      if (next.has(stepId)) next.delete(stepId)
      else next.add(stepId)
      return next
    })
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
  }

  const isRunning = isSubmitting || !!activeTaskId
  const hasActivity = plan || steps.length > 0 || taskResult || isSubmitting

  const getStepIcon = (status: string) => {
    switch (status) {
      case 'running': return <Loader size={16} style={{ color: 'var(--accent)', animation: 'spin 1s linear infinite', flexShrink: 0 }} />
      case 'success': return <CheckCircle size={16} style={{ color: 'var(--success)', flexShrink: 0 }} />
      case 'error': return <XCircle size={16} style={{ color: 'var(--danger)', flexShrink: 0 }} />
      case 'skipped': return <XCircle size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
      default: return <Clock size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
    }
  }

  const getPermBadge = (level: string) => {
    switch (level) {
      case 'read_only': return <span className="badge badge-success">READ</span>
      case 'write': return <span className="badge badge-warning">WRITE</span>
      case 'destructive': return <span className="badge badge-danger">DESTRUCTIVE</span>
      case 'system': return <span className="badge badge-purple">SYSTEM</span>
      default: return <span className="badge badge-muted">{level}</span>
    }
  }

  return (
    <div className="page">
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
        {/* Task feed */}
        <div className="task-feed" ref={feedRef} style={{ flex: 1 }}>
          {!hasActivity && (
            <div className="empty-state">
              <Zap className="icon" size={48} />
              <h3>What would you like to do?</h3>
              <p>
                Describe a task in plain language. Wispyr will create a plan,
                ask for your approval, then execute it step by step.
              </p>
            </div>
          )}

          {/* Planning indicator */}
          {isSubmitting && !plan && (
            <div className="card" style={{ borderColor: 'var(--accent)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <Loader size={16} style={{ color: 'var(--accent)', animation: 'spin 1s linear infinite' }} />
                <span>Generating plan with LLM...</span>
              </div>
            </div>
          )}

          {/* Plan Preview */}
          {plan && (
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
                <button type="button" className="btn btn-primary" onClick={handleApprovePlan}>
                  Start
                </button>
                <button type="button" className="btn btn-secondary" onClick={handleRejectPlan}>
                  Cancel
                </button>
                <div className="plan-meta">
                  {plan.steps.length} steps &middot; Folder: {plan.folder}
                </div>
              </div>
            </div>
          )}

          {/* Step Cards (shown during and after execution) */}
          {!plan && steps.length > 0 && steps.map((step, i) => {
            const isExpanded = expandedSteps.has(step.id)
            return (
              <div className={`step-card ${step.status}`} key={step.id}>
                <div className="step-header" style={{ cursor: 'pointer' }} onClick={() => toggleStepExpanded(step.id)}>
                  {isExpanded ? <ChevronDown size={14} style={{ flexShrink: 0, color: 'var(--text-muted)' }} /> : <ChevronRight size={14} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />}
                  {getStepIcon(step.status)}
                  <span className="step-title">Step {i + 1}: {step.title}</span>
                  {getPermBadge(step.permissionLevel)}
                  {step.completedAt && step.startedAt && (
                    <span className="step-time">
                      {((new Date(step.completedAt).getTime() - new Date(step.startedAt).getTime()) / 1000).toFixed(1)}s
                    </span>
                  )}
                </div>

                {step.result && !isExpanded && step.status === 'success' && (
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginTop: 'var(--space-1)', paddingLeft: '30px' }}>
                    {step.result}
                  </div>
                )}

                {isExpanded && (
                  <div style={{ marginTop: 'var(--space-2)' }}>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginBottom: 'var(--space-1)' }}>
                      {step.description}
                    </div>
                    {step.log && (
                      <div style={{ position: 'relative' }}>
                        <div className={`step-log ${step.status === 'running' ? 'streaming' : ''}`} style={{ maxHeight: '300px' }}>
                          {step.log}
                        </div>
                        {step.status === 'success' && step.log.length > 20 && (
                          <button type="button" className="btn btn-ghost btn-sm" style={{ position: 'absolute', top: '4px', right: '4px', padding: '2px 6px' }} onClick={(e) => { e.stopPropagation(); copyToClipboard(step.log!) }} title="Copy output">
                            <Copy size={10} />
                          </button>
                        )}
                      </div>
                    )}
                    {step.result && step.status === 'success' && (
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--success)', marginTop: 'var(--space-1)', display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
                        <CheckCircle size={10} /> {step.result}
                      </div>
                    )}
                    {step.error && (
                      <div className="step-log" style={{ color: 'var(--danger)' }}>{step.error}</div>
                    )}
                  </div>
                )}
              </div>
            )
          })}

          {/* Permission Modal (inline) */}
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

          {/* Task Result */}
          {taskResult && (
            <div className="card" style={{ borderColor: taskResult.success ? 'var(--success)' : 'var(--danger)', marginTop: 'var(--space-3)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: taskResult.summary ? 'var(--space-3)' : 0 }}>
                {taskResult.success
                  ? <CheckCircle size={18} style={{ color: 'var(--success)', flexShrink: 0 }} />
                  : <AlertTriangle size={18} style={{ color: 'var(--danger)', flexShrink: 0 }} />}
                <span style={{ fontWeight: 500 }}>
                  {taskResult.success ? 'Task completed successfully' : `Task failed: ${taskResult.error || 'Unknown error'}`}
                </span>
                {taskResult.completedAt && taskResult.startedAt && (
                  <span style={{ marginLeft: 'auto', fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                    {((new Date(taskResult.completedAt).getTime() - new Date(taskResult.startedAt).getTime()) / 1000).toFixed(1)}s total
                  </span>
                )}
              </div>
              {taskResult.summary && (
                <div>
                  <div style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 'var(--space-1)', fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginBottom: 'var(--space-2)' }}
                    onClick={() => setShowSummary(!showSummary)}>
                    {showSummary ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    <FileText size={12} />
                    <span>Execution Summary</span>
                  </div>
                  {showSummary && (
                    <div style={{ position: 'relative' }}>
                      <div className="step-log" style={{ maxHeight: '400px', whiteSpace: 'pre-wrap' }}>{taskResult.summary}</div>
                      <button type="button" className="btn btn-ghost btn-sm" style={{ position: 'absolute', top: '4px', right: '4px', padding: '2px 6px' }} onClick={() => copyToClipboard(taskResult.summary!)} title="Copy summary">
                        <Copy size={10} />
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

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
              placeholder="Describe your task... (Shift+Enter for newline)"
              value={task}
              onChange={(e) => setTask(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={2}
              disabled={isRunning}
            />
            <button type="button" className="btn btn-primary btn-lg" onClick={handleSubmit} disabled={!task.trim() || !folder || isRunning}
              style={{ height: '48px', flexShrink: 0 }} aria-label="Send task">
              <Send size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
