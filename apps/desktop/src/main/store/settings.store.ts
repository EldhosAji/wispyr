import Store from 'electron-store'

export interface PermissionRule {
  action: string
  level: 'read_only' | 'write' | 'destructive' | 'system'
  alwaysAllow: boolean
}

interface SettingsSchema {
  theme: 'system' | 'dark' | 'light'
  defaultFolder: string | null
  permissionRules: PermissionRule[]
}

let _store: Store<SettingsSchema> | null = null
function store(): Store<SettingsSchema> {
  if (!_store) {
    _store = new Store<SettingsSchema>({
      name: 'settings',
      defaults: { theme: 'system', defaultFolder: null, permissionRules: [] },
    })
  }
  return _store
}

export function getSettings(): SettingsSchema {
  return {
    theme: store().get('theme'),
    defaultFolder: store().get('defaultFolder'),
    permissionRules: store().get('permissionRules'),
  }
}

export function updateSettings(updates: Partial<SettingsSchema>): void {
  for (const [key, value] of Object.entries(updates)) {
    store().set(key as keyof SettingsSchema, value)
  }
}
