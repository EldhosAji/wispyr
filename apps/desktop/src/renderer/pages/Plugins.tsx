import { useState, useEffect } from 'react'
import { Puzzle, Download, RefreshCw, Power, Trash2, X } from 'lucide-react'

interface PluginInfo {
  id: string
  name: string
  version: string
  description: string
  author: string
  enabled: boolean
  builtIn: boolean
  phase?: string
  type: string
}

interface MCPServer {
  id: string
  name: string
  source: string
  config: any
}

export function Plugins() {
  const [plugins, setPlugins] = useState<PluginInfo[]>([])
  const [discovered, setDiscovered] = useState<MCPServer[]>([])
  const [showInstall, setShowInstall] = useState(false)
  const [installPath, setInstallPath] = useState('')

  const loadPlugins = async () => {
    const list = await window.wispyr.plugins.list()
    setPlugins(list)
  }

  useEffect(() => {
    loadPlugins()
  }, [])

  const handleDiscover = async () => {
    const servers = await window.wispyr.plugins.discover()
    setDiscovered(servers)
  }

  const handleInstall = async () => {
    if (!installPath.trim()) return
    await window.wispyr.plugins.install(installPath)
    setInstallPath('')
    setShowInstall(false)
    await loadPlugins()
  }

  const handleToggle = async (id: string, enabled: boolean) => {
    await window.wispyr.plugins.toggle(id, enabled)
    await loadPlugins()
  }

  const handleRemove = async (id: string) => {
    await window.wispyr.plugins.remove(id)
    await loadPlugins()
  }

  const builtInPlugins = plugins.filter((p) => p.builtIn)
  const userPlugins = plugins.filter((p) => !p.builtIn)

  return (
    <div className="page">
      <div className="page-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h1>Plugins</h1>
          <p>Extend Wispyr with skills and MCP servers</p>
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <button type="button" className="btn btn-secondary" onClick={handleDiscover}>
            <RefreshCw size={14} /> Discover MCP
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setShowInstall(true)}>
            <Download size={14} /> Install
          </button>
        </div>
      </div>
      <div className="page-body">
        {/* Install form */}
        {showInstall && (
          <div className="card" style={{ marginBottom: 'var(--space-4)', borderColor: 'var(--border-accent)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-3)' }}>
              <span style={{ fontSize: 'var(--text-sm)', fontWeight: 500 }}>Install Plugin</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowInstall(false)} aria-label="Close">
                <X size={12} />
              </button>
            </div>
            <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
              <input
                className="input"
                value={installPath}
                onChange={(e) => setInstallPath(e.target.value)}
                placeholder="NPM package name or local folder path"
                style={{ flex: 1 }}
              />
              <button type="button" className="btn btn-primary" onClick={handleInstall} disabled={!installPath.trim()}>
                Install
              </button>
            </div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 'var(--space-2)' }}>
              Enter an NPM package name (e.g. wispyr-plugin-notion) or a local folder path.
            </div>
          </div>
        )}

        {/* MCP Discovery results */}
        {discovered.length > 0 && (
          <div className="section">
            <div className="section-title">Discovered MCP Servers</div>
            {discovered.map((server) => (
              <div className="card" key={server.id}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                  <span className="badge badge-accent">MCP</span>
                  <span style={{ fontWeight: 500 }}>{server.name}</span>
                  <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)' }}>
                    {server.source}
                  </span>
                  <button type="button" className="btn btn-primary btn-sm" style={{ marginLeft: 'auto' }}
                    onClick={() => {
                      window.wispyr.plugins.install(server.id)
                      loadPlugins()
                    }}>
                    Enable
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Built-in Skills */}
        <div className="section">
          <div className="section-title">Built-in Skills</div>
          {builtInPlugins.map((plugin) => (
            <div className="card" key={plugin.id}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                {plugin.enabled
                  ? <span className="badge badge-success">Active</span>
                  : <span className="badge badge-muted">{plugin.phase || 'Disabled'}</span>}
                <span style={{ fontWeight: 500 }}>{plugin.name}</span>
                <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', flex: 1 }}>
                  {plugin.description}
                </span>
                <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)' }}>
                  v{plugin.version}
                </span>
              </div>
            </div>
          ))}
        </div>

        {/* User Plugins */}
        <div className="section">
          <div className="section-title">Installed Plugins</div>
          {userPlugins.length === 0 ? (
            <div className="empty-state" style={{ padding: 'var(--space-6)' }}>
              <Puzzle className="icon" size={36} />
              <h3>No plugins installed</h3>
              <p>Install plugins via NPM, local folder, or discover MCP servers already on your machine.</p>
            </div>
          ) : (
            userPlugins.map((plugin) => (
              <div className="card" key={plugin.id}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                  {plugin.enabled
                    ? <span className="badge badge-success">Enabled</span>
                    : <span className="badge badge-muted">Disabled</span>}
                  <span style={{ fontWeight: 500 }}>{plugin.name}</span>
                  <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', flex: 1 }}>
                    {plugin.description}
                  </span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => handleToggle(plugin.id, !plugin.enabled)}
                    title={plugin.enabled ? 'Disable' : 'Enable'}
                  >
                    <Power size={12} /> {plugin.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => handleRemove(plugin.id)} title="Remove" style={{ color: 'var(--danger)' }}>
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
