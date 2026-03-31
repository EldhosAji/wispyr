import Store from 'electron-store'

export interface ProviderConfig {
  id: string
  name: string
  type: 'anthropic' | 'openai' | 'ollama' | 'gemini' | 'groq' | 'azure' | 'custom'
  baseUrl: string
  model: string
  apiKey?: string
  customHeaders?: Record<string, string>
  fallbackPriority?: number
}

interface ProvidersSchema {
  providers: ProviderConfig[]
  activeProviderId: string | null
}

let _store: Store<ProvidersSchema> | null = null
function store(): Store<ProvidersSchema> {
  if (!_store) {
    _store = new Store<ProvidersSchema>({
      name: 'providers',
      defaults: { providers: [], activeProviderId: null },
    })
  }
  return _store
}

export function getProviders(): ProviderConfig[] {
  return store().get('providers')
}

export function getActiveProviderId(): string | null {
  return store().get('activeProviderId')
}

export function addProvider(provider: ProviderConfig): void {
  const providers = getProviders()
  providers.push(provider)
  store().set('providers', providers)
  if (providers.length === 1) {
    store().set('activeProviderId', provider.id)
  }
}

export function removeProvider(id: string): void {
  const providers = getProviders().filter((p) => p.id !== id)
  store().set('providers', providers)
  if (getActiveProviderId() === id) {
    store().set('activeProviderId', providers.length > 0 ? providers[0].id : null)
  }
}

export function updateProvider(id: string, updates: Partial<ProviderConfig>): void {
  const providers = getProviders().map((p) =>
    p.id === id ? { ...p, ...updates } : p
  )
  store().set('providers', providers)
}

export function setActiveProvider(id: string): void {
  const providers = getProviders()
  if (providers.some((p) => p.id === id)) {
    store().set('activeProviderId', id)
  }
}

export function getActiveProvider(): ProviderConfig | null {
  const id = getActiveProviderId()
  if (!id) return null
  return getProviders().find((p) => p.id === id) || null
}
