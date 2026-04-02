import Store from 'electron-store'

export interface PermissionRule {
  action: string
  level: 'read_only' | 'write' | 'destructive' | 'system'
  alwaysAllow: boolean
}

export interface FeatureFlags {
  shellTool: boolean
  webFetchTool: boolean
  browserTool: boolean
  subAgents: boolean
  hookSystem: boolean
  mcpBridge: boolean
  scheduler: boolean
  desktopAutomation: boolean
  autoSkillGeneration: boolean
}

const DEFAULT_FEATURES: FeatureFlags = {
  shellTool: true,
  webFetchTool: true,
  browserTool: false,
  subAgents: true,
  hookSystem: true,
  mcpBridge: true,
  scheduler: true,
  desktopAutomation: false,
  autoSkillGeneration: true,
}

interface SettingsSchema {
  theme: 'system' | 'dark' | 'light'
  defaultFolder: string | null
  permissionRules: PermissionRule[]
  features: FeatureFlags
  maxCostPerTaskUSD: number
}

let _store: Store<SettingsSchema> | null = null
function store(): Store<SettingsSchema> {
  if (!_store) {
    _store = new Store<SettingsSchema>({
      name: 'settings',
      defaults: {
        theme: 'system',
        defaultFolder: null,
        permissionRules: [],
        features: DEFAULT_FEATURES,
        maxCostPerTaskUSD: 1.0,
      },
    })
  }
  return _store
}

export function getSettings(): SettingsSchema {
  return {
    theme: store().get('theme'),
    defaultFolder: store().get('defaultFolder'),
    permissionRules: store().get('permissionRules'),
    features: { ...DEFAULT_FEATURES, ...store().get('features') },
    maxCostPerTaskUSD: store().get('maxCostPerTaskUSD'),
  }
}

export function getFeatureFlags(): FeatureFlags {
  return { ...DEFAULT_FEATURES, ...store().get('features') }
}

export function isFeatureEnabled(feature: keyof FeatureFlags): boolean {
  const flags = getFeatureFlags()
  return flags[feature] ?? false
}

export function updateSettings(updates: Partial<SettingsSchema>): void {
  for (const [key, value] of Object.entries(updates)) {
    store().set(key as keyof SettingsSchema, value)
  }
}
