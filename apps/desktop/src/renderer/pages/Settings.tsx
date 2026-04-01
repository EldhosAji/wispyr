import { useState, useEffect } from 'react'
import { Settings as SettingsIcon, Shield, ScrollText, Cpu, Plus, Trash2, Check, X, Radio, TestTube, ChevronDown } from 'lucide-react'

type SettingsTab = 'providers' | 'permissions' | 'audit' | 'general'

interface Provider {
  id: string
  name: string
  type: string
  baseUrl: string
  model: string
  hasApiKey?: boolean
  isActive: boolean
}

interface AuditEntry {
  id: number
  timestamp: string
  skill: string
  action: string
  params: string
  result?: string
  permission: string
}

interface SettingsProps {
  onProviderChange: () => void
}

const PROVIDER_DEFAULTS: Record<string, { baseUrl: string; model: string }> = {
  ollama:    { baseUrl: 'http://localhost:11434', model: 'llama3.1' },
  openai:    { baseUrl: 'https://api.openai.com', model: 'gpt-4o' },
  anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-6' },
  azure:     { baseUrl: 'https://your-resource.openai.azure.com', model: 'gpt-4o' },
  gemini:    { baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-2.0-flash' },
  groq:      { baseUrl: 'https://api.groq.com', model: 'llama-3.1-70b-versatile' },
  custom:    { baseUrl: 'http://localhost:8080', model: 'default' },
}

export function Settings({ onProviderChange }: SettingsProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('providers')
  const [providers, setProviders] = useState<Provider[]>([])
  const [showAddForm, setShowAddForm] = useState(false)
  const [testResults, setTestResults] = useState<Record<string, { success: boolean; error?: string }>>({})
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([])
  const [auditSearch, setAuditSearch] = useState('')

  // Add form state
  const [formName, setFormName] = useState('')
  const [formType, setFormType] = useState('ollama')
  const [formBaseUrl, setFormBaseUrl] = useState('http://localhost:11434')
  const [formModel, setFormModel] = useState('llama3.1')
  const [formApiKey, setFormApiKey] = useState('')

  const loadProviders = async () => {
    const list = await window.wispyr.providers.list()
    setProviders(list)
  }

  const loadAudit = async () => {
    const filter = auditSearch ? { search: auditSearch } : undefined
    const entries = await window.wispyr.audit.list(filter)
    setAuditEntries(entries)
  }

  useEffect(() => {
    loadProviders()
  }, [])

  useEffect(() => {
    if (activeTab === 'audit') loadAudit()
  }, [activeTab, auditSearch])

  const handleTypeChange = (type: string) => {
    setFormType(type)
    const defaults = PROVIDER_DEFAULTS[type]
    if (defaults) {
      setFormBaseUrl(defaults.baseUrl)
      setFormModel(defaults.model)
    }
  }

  const handleAddProvider = async () => {
    if (!formName.trim()) return
    await window.wispyr.providers.add({
      name: formName,
      type: formType,
      baseUrl: formBaseUrl,
      model: formModel,
      apiKey: formApiKey || undefined,
    })
    setShowAddForm(false)
    setFormName('')
    setFormApiKey('')
    handleTypeChange('ollama')
    await loadProviders()
    onProviderChange()
  }

  const handleRemoveProvider = async (id: string) => {
    await window.wispyr.providers.remove(id)
    await loadProviders()
    onProviderChange()
  }

  const handleSetActive = async (id: string) => {
    await window.wispyr.providers.setActive(id)
    await loadProviders()
    onProviderChange()
  }

  const handleTestProvider = async (id: string) => {
    setTestResults((prev) => ({ ...prev, [id]: { success: false, error: 'Testing...' } }))
    const result = await window.wispyr.providers.test(id)
    setTestResults((prev) => ({ ...prev, [id]: result }))
  }

  const handleExportAudit = async (format: 'csv' | 'json') => {
    await window.wispyr.audit.export(format)
  }

  const tabs: { id: SettingsTab; label: string; icon: typeof Cpu }[] = [
    { id: 'providers',   label: 'Providers',   icon: Cpu },
    { id: 'permissions', label: 'Permissions',  icon: Shield },
    { id: 'audit',       label: 'Audit Log',    icon: ScrollText },
    { id: 'general',     label: 'General',      icon: SettingsIcon },
  ]

  return (
    <div className="page">
      <div className="page-header">
        <h1>Settings</h1>
        <p>Configure providers, permissions, and preferences</p>
      </div>
      <div className="page-body">
        {/* Tab bar */}
        <div style={{ display: 'flex', gap: 'var(--space-1)', marginBottom: 'var(--space-5)' }}>
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              type="button"
              key={id}
              className={`btn ${activeTab === id ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setActiveTab(id)}
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
        </div>

        {/* ─── Providers Tab ─── */}
        {activeTab === 'providers' && (
          <div className="section">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-3)' }}>
              <div className="section-title" style={{ margin: 0 }}>LLM Providers</div>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setShowAddForm(true)}>
                <Plus size={12} /> Add Provider
              </button>
            </div>

            {/* Add form */}
            {showAddForm && (
              <div className="card" style={{ marginBottom: 'var(--space-3)', borderColor: 'var(--border-accent)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-3)' }}>
                  <span style={{ fontSize: 'var(--text-sm)', fontWeight: 500 }}>New Provider</span>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowAddForm(false)}>
                    <X size={12} />
                  </button>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
                  <div>
                    <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', display: 'block', marginBottom: 'var(--space-1)' }}>Name</label>
                    <input className="input" value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="e.g. My Ollama" />
                  </div>
                  <div>
                    <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', display: 'block', marginBottom: 'var(--space-1)' }}>Type</label>
                    <select className="input" value={formType} onChange={(e) => handleTypeChange(e.target.value)}>
                      <option value="ollama">Ollama (Local)</option>
                      <option value="openai">OpenAI</option>
                      <option value="azure">Azure OpenAI</option>
                      <option value="anthropic">Claude (Anthropic)</option>
                      <option value="gemini">Google Gemini</option>
                      <option value="groq">Groq</option>
                      <option value="custom">Custom (OpenAI-compatible)</option>
                    </select>
                  </div>
                  <div>
                    <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', display: 'block', marginBottom: 'var(--space-1)' }}>Base URL</label>
                    <input className="input" value={formBaseUrl} onChange={(e) => setFormBaseUrl(e.target.value)} placeholder="http://localhost:11434" />
                  </div>
                  <div>
                    <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', display: 'block', marginBottom: 'var(--space-1)' }}>Model</label>
                    <input className="input" value={formModel} onChange={(e) => setFormModel(e.target.value)} placeholder="llama3.1" />
                  </div>
                  {formType !== 'ollama' && (
                    <div style={{ gridColumn: '1 / -1' }}>
                      <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', display: 'block', marginBottom: 'var(--space-1)' }}>API Key</label>
                      <input className="input" type="password" value={formApiKey} onChange={(e) => setFormApiKey(e.target.value)} placeholder="sk-..." />
                    </div>
                  )}
                </div>

                <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-4)' }}>
                  <button type="button" className="btn btn-primary" onClick={handleAddProvider} disabled={!formName.trim()}>
                    <Plus size={14} /> Add
                  </button>
                  <button type="button" className="btn btn-secondary" onClick={() => setShowAddForm(false)}>Cancel</button>
                </div>
              </div>
            )}

            {/* Provider list */}
            {providers.length === 0 && !showAddForm && (
              <div className="card">
                <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
                  No providers configured. Add an LLM provider to start using Wispyr.
                  Ollama is recommended for local use (no API key needed).
                </p>
              </div>
            )}

            {providers.map((p) => (
              <div className="card" key={p.id} style={{ borderColor: p.isActive ? 'var(--accent)' : undefined }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                  {p.isActive && <span className="badge badge-accent">Active</span>}
                  <span style={{ fontWeight: 500 }}>{p.name}</span>
                  <span className="badge badge-muted">{p.type}</span>
                  <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>{p.model}</span>

                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 'var(--space-1)' }}>
                    {!p.isActive && (
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => handleSetActive(p.id)} title="Set as active">
                        <Radio size={12} /> Activate
                      </button>
                    )}
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => handleTestProvider(p.id)} title="Test connection">
                      <TestTube size={12} /> Test
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => handleRemoveProvider(p.id)} title="Remove provider" style={{ color: 'var(--danger)' }}>
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
                {testResults[p.id] && (
                  <div style={{ marginTop: 'var(--space-2)', fontSize: 'var(--text-xs)', display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
                    {testResults[p.id].success
                      ? <><Check size={12} style={{ color: 'var(--success)' }} /> <span style={{ color: 'var(--success)' }}>Connection successful</span></>
                      : <><X size={12} style={{ color: 'var(--danger)' }} /> <span style={{ color: 'var(--danger)' }}>{testResults[p.id].error}</span></>}
                  </div>
                )}
                <div style={{ marginTop: 'var(--space-1)', fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                  {p.baseUrl}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ─── Permissions Tab ─── */}
        {activeTab === 'permissions' && (
          <div className="section">
            <div className="section-title">Permission Levels</div>
            <div className="card">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                  <span className="badge badge-success">READ_ONLY</span>
                  <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
                    Auto-approved, logged silently
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                  <span className="badge badge-warning">WRITE</span>
                  <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
                    Approve once per session per action type. "Allow for session" available.
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                  <span className="badge badge-danger">DESTRUCTIVE</span>
                  <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
                    Must approve every single time. 3-second countdown. No "remember" option.
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                  <span className="badge badge-purple">SYSTEM</span>
                  <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
                    Must type "CONFIRM" in text field. No exceptions. No shortcut.
                  </span>
                </div>
              </div>
            </div>
            <div className="card" style={{ marginTop: 'var(--space-3)' }}>
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
                Session approvals are cleared when the app restarts. Destructive and System level approvals are never remembered.
              </div>
            </div>
          </div>
        )}

        {/* ─── Audit Log Tab ─── */}
        {activeTab === 'audit' && (
          <div className="section">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-3)' }}>
              <div className="section-title" style={{ margin: 0 }}>Audit Log</div>
              <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => handleExportAudit('csv')}>Export CSV</button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => handleExportAudit('json')}>Export JSON</button>
              </div>
            </div>

            <div style={{ marginBottom: 'var(--space-3)' }}>
              <input
                className="input"
                placeholder="Search audit log..."
                value={auditSearch}
                onChange={(e) => setAuditSearch(e.target.value)}
              />
            </div>

            {auditEntries.length === 0 ? (
              <div className="card">
                <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
                  {auditSearch ? 'No entries match your search.' : 'No audit entries yet. Actions will be logged here as you use Wispyr.'}
                </p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                {auditEntries.map((entry) => (
                  <div className="card" key={entry.id} style={{ padding: 'var(--space-2) var(--space-3)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--text-xs)' }}>
                      <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', minWidth: '160px' }}>
                        {new Date(entry.timestamp).toLocaleString()}
                      </span>
                      <span className="badge badge-muted">{entry.skill}</span>
                      <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{entry.action}</span>
                      <span className={`badge ${
                        entry.permission === 'auto-approved' ? 'badge-success' :
                        entry.permission === 'approved' ? 'badge-accent' :
                        entry.permission === 'denied' ? 'badge-danger' : 'badge-muted'
                      }`}>
                        {entry.permission}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ─── General Tab ─── */}
        {activeTab === 'general' && (
          <div className="section">
            <div className="section-title">Application</div>
            <div className="card">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                <div style={{ fontSize: 'var(--text-sm)' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>Version: </span>
                  <span>0.1.0</span>
                </div>
                <div style={{ fontSize: 'var(--text-sm)' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>License: </span>
                  <span>MIT</span>
                </div>
                <div style={{ fontSize: 'var(--text-sm)' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>Platform: </span>
                  <span>Windows x64</span>
                </div>
                <div style={{ fontSize: 'var(--text-sm)' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>Stack: </span>
                  <span>Electron + TypeScript + React</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
