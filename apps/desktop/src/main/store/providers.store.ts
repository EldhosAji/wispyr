import Store from 'electron-store'
import { safeStorage } from 'electron'

const ENCRYPTED_PREFIX = 'enc::'

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

/** Encrypt an API key using the OS keychain via Electron safeStorage */
function encryptKey(plainKey: string): string {
  if (!plainKey) return ''
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(plainKey).toString('base64')
    return ENCRYPTED_PREFIX + encrypted
  }
  // Fallback: store as-is if OS encryption unavailable (e.g. Linux without keyring)
  return plainKey
}

/** Decrypt an API key — handles both encrypted and legacy plain-text keys */
function decryptKey(storedKey: string): string {
  if (!storedKey) return ''
  if (storedKey.startsWith(ENCRYPTED_PREFIX)) {
    const encrypted = Buffer.from(storedKey.slice(ENCRYPTED_PREFIX.length), 'base64')
    return safeStorage.decryptString(encrypted)
  }
  // Legacy plain-text key — return as-is (will be re-encrypted on next save)
  return storedKey
}

/** Read raw providers from disk (keys still encrypted) */
function getRawProviders(): ProviderConfig[] {
  return store().get('providers')
}

/** Save providers with API keys encrypted */
function saveProviders(providers: ProviderConfig[]): void {
  const encrypted = providers.map((p) => ({
    ...p,
    apiKey: p.apiKey ? encryptKey(p.apiKey) : undefined,
  }))
  store().set('providers', encrypted)
}

/** Get all providers with decrypted API keys (main process only) */
export function getProviders(): ProviderConfig[] {
  return getRawProviders().map((p) => ({
    ...p,
    apiKey: p.apiKey ? decryptKey(p.apiKey) : undefined,
  }))
}

/** Get providers with API keys masked — safe to send to renderer */
export function getProvidersSafe(): (ProviderConfig & { hasApiKey: boolean })[] {
  return getRawProviders().map((p) => ({
    ...p,
    apiKey: undefined,
    hasApiKey: !!p.apiKey,
  }))
}

export function getActiveProviderId(): string | null {
  return store().get('activeProviderId')
}

export function addProvider(provider: ProviderConfig): void {
  const raw = getRawProviders()
  raw.push({
    ...provider,
    apiKey: provider.apiKey ? encryptKey(provider.apiKey) : undefined,
  })
  store().set('providers', raw)
  if (raw.length === 1) {
    store().set('activeProviderId', provider.id)
  }
}

export function removeProvider(id: string): void {
  const providers = getRawProviders().filter((p) => p.id !== id)
  store().set('providers', providers)
  if (getActiveProviderId() === id) {
    store().set('activeProviderId', providers.length > 0 ? providers[0].id : null)
  }
}

export function updateProvider(id: string, updates: Partial<ProviderConfig>): void {
  const raw = getRawProviders()
  const updated = raw.map((p) => {
    if (p.id !== id) return p
    const merged = { ...p, ...updates }
    // Re-encrypt if apiKey was updated with a new plain-text value
    if (updates.apiKey && !updates.apiKey.startsWith(ENCRYPTED_PREFIX)) {
      merged.apiKey = encryptKey(updates.apiKey)
    }
    return merged
  })
  store().set('providers', updated)
}

export function setActiveProvider(id: string): void {
  const providers = getRawProviders()
  if (providers.some((p) => p.id === id)) {
    store().set('activeProviderId', id)
  }
}

export function getActiveProvider(): ProviderConfig | null {
  const id = getActiveProviderId()
  if (!id) return null
  return getProviders().find((p) => p.id === id) || null
}
