import Store from 'electron-store'

export interface PluginInfo {
  id: string
  name: string
  version: string
  description: string
  author: string
  enabled: boolean
  builtIn: boolean
  phase?: string
  type: 'skill' | 'mcp'
}

interface PluginsSchema {
  plugins: PluginInfo[]
}

const BUILT_IN_PLUGINS: PluginInfo[] = [
  { id: 'filesystem', name: 'Filesystem', version: '1.0.0', description: 'Read and write files in your approved folder', author: 'Wispyr', enabled: true, builtIn: true, type: 'skill' },
  { id: 'browser', name: 'Browser', version: '0.0.0', description: 'Web browsing and data extraction via Playwright', author: 'Wispyr', enabled: false, builtIn: true, phase: 'Phase 6', type: 'skill' },
  { id: 'desktop', name: 'Desktop', version: '0.0.0', description: 'Desktop computer use with accessibility + vision', author: 'Wispyr', enabled: false, builtIn: true, phase: 'Phase 7', type: 'skill' },
  { id: 'shell', name: 'Shell', version: '0.0.0', description: 'Sandboxed command execution', author: 'Wispyr', enabled: false, builtIn: true, phase: 'Phase 8', type: 'skill' },
  { id: 'scheduler', name: 'Scheduler', version: '0.0.0', description: 'Cron-based task scheduling', author: 'Wispyr', enabled: false, builtIn: true, phase: 'Phase 8', type: 'skill' },
]

let _store: Store<PluginsSchema> | null = null
function store(): Store<PluginsSchema> {
  if (!_store) {
    _store = new Store<PluginsSchema>({
      name: 'plugins',
      defaults: { plugins: [] },
    })
  }
  return _store
}

export function getPlugins(): PluginInfo[] {
  const userPlugins = store().get('plugins')
  return [...BUILT_IN_PLUGINS, ...userPlugins]
}

export function togglePlugin(id: string, enabled: boolean): boolean {
  const builtIn = BUILT_IN_PLUGINS.find((p) => p.id === id)
  if (builtIn && builtIn.phase) return false
  if (builtIn) return false

  const plugins = store().get('plugins').map((p) =>
    p.id === id ? { ...p, enabled } : p
  )
  store().set('plugins', plugins)
  return true
}

export function installPlugin(plugin: Omit<PluginInfo, 'builtIn'>): void {
  const plugins = store().get('plugins')
  plugins.push({ ...plugin, builtIn: false })
  store().set('plugins', plugins)
}

export function removePlugin(id: string): boolean {
  const plugins = store().get('plugins')
  const filtered = plugins.filter((p) => p.id !== id)
  if (filtered.length === plugins.length) return false
  store().set('plugins', filtered)
  return true
}
