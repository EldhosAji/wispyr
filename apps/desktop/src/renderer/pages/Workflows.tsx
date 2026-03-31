import { useState, useEffect } from 'react'
import { Workflow as WorkflowIcon, Plus, Upload, Play, Trash2, X } from 'lucide-react'

interface Workflow {
  id: string
  name: string
  description: string
  author: string
  version: string
  inputs: any[]
  steps: any[]
  createdAt: string
  lastRun?: string
}

export function Workflows() {
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [showCreateForm, setShowCreateForm] = useState(false)

  // Create form state
  const [formName, setFormName] = useState('')
  const [formDescription, setFormDescription] = useState('')
  const [formStepTitle, setFormStepTitle] = useState('')
  const [formStepSkill, setFormStepSkill] = useState('filesystem')
  const [formSteps, setFormSteps] = useState<{ id: string; title: string; skill: string }[]>([])

  const loadWorkflows = async () => {
    const list = await window.wispyr.workflows.list()
    setWorkflows(list)
  }

  useEffect(() => {
    loadWorkflows()
  }, [])

  const handleCreate = async () => {
    if (!formName.trim()) return
    await window.wispyr.workflows.save({
      name: formName,
      description: formDescription,
      author: 'User',
      version: '1.0.0',
      inputs: [],
      steps: formSteps.map((s) => ({
        id: s.id,
        title: s.title,
        skill: s.skill,
      })),
    })
    setShowCreateForm(false)
    setFormName('')
    setFormDescription('')
    setFormSteps([])
    await loadWorkflows()
  }

  const handleAddStep = () => {
    if (!formStepTitle.trim()) return
    setFormSteps([...formSteps, {
      id: Date.now().toString(36),
      title: formStepTitle,
      skill: formStepSkill,
    }])
    setFormStepTitle('')
  }

  const handleRemoveStep = (id: string) => {
    setFormSteps(formSteps.filter((s) => s.id !== id))
  }

  const handleImport = async () => {
    const result = await window.wispyr.workflows.import()
    if (result.success) {
      await loadWorkflows()
    }
  }

  const handleDelete = async (id: string) => {
    await window.wispyr.workflows.delete(id)
    await loadWorkflows()
  }

  const handleRun = async (id: string) => {
    await window.wispyr.workflows.run(id, {})
    await loadWorkflows()
  }

  return (
    <div className="page">
      <div className="page-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h1>Workflows</h1>
          <p>Reusable task templates</p>
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <button type="button" className="btn btn-secondary" onClick={handleImport}>
            <Upload size={14} /> Import
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setShowCreateForm(true)}>
            <Plus size={14} /> Create
          </button>
        </div>
      </div>
      <div className="page-body">
        {/* Create form */}
        {showCreateForm && (
          <div className="card" style={{ marginBottom: 'var(--space-4)', borderColor: 'var(--border-accent)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-3)' }}>
              <span style={{ fontSize: 'var(--text-sm)', fontWeight: 500 }}>New Workflow</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowCreateForm(false)}>
                <X size={12} />
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
              <div>
                <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', display: 'block', marginBottom: 'var(--space-1)' }}>Name</label>
                <input className="input" value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="e.g. Weekly Status Report" />
              </div>
              <div>
                <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', display: 'block', marginBottom: 'var(--space-1)' }}>Description</label>
                <input className="input" value={formDescription} onChange={(e) => setFormDescription(e.target.value)} placeholder="What does this workflow do?" />
              </div>

              {/* Steps builder */}
              <div>
                <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', display: 'block', marginBottom: 'var(--space-1)' }}>Steps</label>
                {formSteps.map((step, i) => (
                  <div key={step.id} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-1)', fontSize: 'var(--text-xs)' }}>
                    <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', width: '20px' }}>{i + 1}</span>
                    <span style={{ flex: 1 }}>{step.title}</span>
                    <span className="badge badge-muted">{step.skill}</span>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => handleRemoveStep(step.id)} aria-label="Remove step">
                      <Trash2 size={10} />
                    </button>
                  </div>
                ))}
                <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
                  <input className="input" value={formStepTitle} onChange={(e) => setFormStepTitle(e.target.value)} placeholder="Step title" style={{ flex: 1 }} />
                  <select className="input" value={formStepSkill} onChange={(e) => setFormStepSkill(e.target.value)} style={{ width: '140px' }}>
                    <option value="filesystem">Filesystem</option>
                    <option value="llm">LLM</option>
                    <option value="browser">Browser</option>
                    <option value="shell">Shell</option>
                  </select>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={handleAddStep} disabled={!formStepTitle.trim()}>
                    <Plus size={12} /> Add
                  </button>
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-4)' }}>
              <button type="button" className="btn btn-primary" onClick={handleCreate} disabled={!formName.trim() || formSteps.length === 0}>
                Create Workflow
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setShowCreateForm(false)}>Cancel</button>
            </div>
          </div>
        )}

        {/* Workflow list */}
        {workflows.length === 0 && !showCreateForm ? (
          <div className="empty-state">
            <WorkflowIcon className="icon" size={48} />
            <h3>No workflows yet</h3>
            <p>
              Create a workflow from scratch, import a JSON file, or save a
              successful task as a workflow.
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            {workflows.map((w) => (
              <div className="card" key={w.id}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                  <WorkflowIcon size={16} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 500, fontSize: 'var(--text-sm)' }}>{w.name}</div>
                    {w.description && (
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginTop: '2px' }}>{w.description}</div>
                    )}
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: '2px', fontFamily: 'var(--font-mono)' }}>
                      {w.steps.length} steps &middot; by {w.author}
                      {w.lastRun && <> &middot; Last run: {new Date(w.lastRun).toLocaleString()}</>}
                    </div>
                  </div>
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => handleRun(w.id)} aria-label={`Run ${w.name}`}>
                    <Play size={12} /> Run
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => handleDelete(w.id)} aria-label={`Delete ${w.name}`} style={{ color: 'var(--danger)' }}>
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
