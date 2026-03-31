import { useState, useEffect } from 'react'
import { ListTodo, Clock, CheckCircle, XCircle, Loader, ChevronDown, ChevronRight } from 'lucide-react'

interface TaskStep {
  id: string
  title: string
  description: string
  status: string
  permissionLevel: string
  log?: string
}

interface Task {
  id: string
  description: string
  folder: string
  status: string
  steps: TaskStep[]
  createdAt: string
  completedAt?: string
  error?: string
}

export function Tasks() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [expandedTask, setExpandedTask] = useState<string | null>(null)

  const loadTasks = async () => {
    const list = await window.wispyr.tasks.list()
    setTasks(list)
  }

  useEffect(() => {
    loadTasks()
    const interval = setInterval(loadTasks, 3000)
    return () => clearInterval(interval)
  }, [])

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'completed': return <CheckCircle size={14} style={{ color: 'var(--success)' }} />
      case 'failed': return <XCircle size={14} style={{ color: 'var(--danger)' }} />
      case 'cancelled': return <XCircle size={14} style={{ color: 'var(--text-muted)' }} />
      case 'running': return <Loader size={14} style={{ color: 'var(--accent)', animation: 'spin 1s linear infinite' }} />
      case 'planning': return <Loader size={14} style={{ color: 'var(--warning)', animation: 'spin 1s linear infinite' }} />
      default: return <Clock size={14} style={{ color: 'var(--text-muted)' }} />
    }
  }

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'completed': return <span className="badge badge-success">Completed</span>
      case 'failed': return <span className="badge badge-danger">Failed</span>
      case 'cancelled': return <span className="badge badge-muted">Cancelled</span>
      case 'running': return <span className="badge badge-accent">Running</span>
      case 'planning': return <span className="badge badge-warning">Planning</span>
      case 'awaiting_approval': return <span className="badge badge-warning">Awaiting Approval</span>
      default: return <span className="badge badge-muted">{status}</span>
    }
  }

  return (
    <div className="page">
      <div className="page-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h1>Tasks</h1>
          <p>Task history and execution logs</p>
        </div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={loadTasks}>Refresh</button>
      </div>
      <div className="page-body">
        {tasks.length === 0 ? (
          <div className="empty-state">
            <ListTodo className="icon" size={48} />
            <h3>No tasks yet</h3>
            <p>Tasks you run from the Home page will appear here with their full execution history.</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            {tasks.map((task) => (
              <div className="card" key={task.id}>
                <div
                  style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', cursor: 'pointer' }}
                  onClick={() => setExpandedTask(expandedTask === task.id ? null : task.id)}
                >
                  {expandedTask === task.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  {getStatusIcon(task.status)}
                  <span style={{ flex: 1, fontWeight: 500, fontSize: 'var(--text-sm)' }}>{task.description}</span>
                  {getStatusBadge(task.status)}
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                    {new Date(task.createdAt).toLocaleString()}
                  </span>
                </div>

                {expandedTask === task.id && (
                  <div style={{ marginTop: 'var(--space-3)', paddingTop: 'var(--space-3)', borderTop: '1px solid var(--border)' }}>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginBottom: 'var(--space-2)', fontFamily: 'var(--font-mono)' }}>
                      Folder: {task.folder}
                    </div>
                    {task.error && (
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--danger)', marginBottom: 'var(--space-2)' }}>
                        Error: {task.error}
                      </div>
                    )}
                    {task.steps.length > 0 && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                        {task.steps.map((step, i) => (
                          <div key={step.id} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--text-xs)', padding: 'var(--space-1) 0' }}>
                            {getStatusIcon(step.status)}
                            <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', width: '20px' }}>{i + 1}</span>
                            <span>{step.title}</span>
                            <span className={`badge ${step.permissionLevel === 'read_only' ? 'badge-success' : step.permissionLevel === 'write' ? 'badge-warning' : step.permissionLevel === 'destructive' ? 'badge-danger' : 'badge-purple'}`} style={{ fontSize: '10px' }}>
                              {step.permissionLevel}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
