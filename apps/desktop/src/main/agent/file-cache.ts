/**
 * File State Cache — LRU cache for file reads within a task.
 *
 * Avoids duplicate disk I/O when multiple steps reference the same files.
 * Invalidated on write/delete/move operations.
 */

const DEFAULT_MAX_ENTRIES = 50
const DEFAULT_MAX_CONTENT_SIZE = 500_000 // ~500KB per entry

export class FileCache {
  private _cache = new Map<string, { content: string; accessedAt: number }>()
  private _maxEntries: number
  private _maxContentSize: number

  constructor(maxEntries = DEFAULT_MAX_ENTRIES, maxContentSize = DEFAULT_MAX_CONTENT_SIZE) {
    this._maxEntries = maxEntries
    this._maxContentSize = maxContentSize
  }

  get(filePath: string): string | undefined {
    const entry = this._cache.get(filePath)
    if (!entry) return undefined
    // Update access time for LRU
    entry.accessedAt = Date.now()
    return entry.content
  }

  set(filePath: string, content: string): void {
    // Don't cache very large files
    if (content.length > this._maxContentSize) return

    // Evict LRU if at capacity
    if (this._cache.size >= this._maxEntries && !this._cache.has(filePath)) {
      this.evictLRU()
    }

    this._cache.set(filePath, { content, accessedAt: Date.now() })
  }

  has(filePath: string): boolean {
    return this._cache.has(filePath)
  }

  /** Invalidate a specific file (call after writes/deletes) */
  invalidate(filePath: string): void {
    this._cache.delete(filePath)
  }

  /** Invalidate all files in a directory */
  invalidateDir(dirPath: string): void {
    const prefix = dirPath.endsWith('/') || dirPath.endsWith('\\') ? dirPath : dirPath + '/'
    for (const key of this._cache.keys()) {
      if (key.startsWith(prefix) || key === dirPath) {
        this._cache.delete(key)
      }
    }
  }

  /** Clear entire cache */
  clear(): void {
    this._cache.clear()
  }

  /** Number of cached entries */
  get size(): number {
    return this._cache.size
  }

  /** Convert to a plain Map for use in ToolContext */
  toMap(): Map<string, string> {
    const map = new Map<string, string>()
    for (const [key, entry] of this._cache) {
      map.set(key, entry.content)
    }
    return map
  }

  private evictLRU(): void {
    let oldestKey: string | null = null
    let oldestTime = Infinity

    for (const [key, entry] of this._cache) {
      if (entry.accessedAt < oldestTime) {
        oldestTime = entry.accessedAt
        oldestKey = key
      }
    }

    if (oldestKey) this._cache.delete(oldestKey)
  }
}
