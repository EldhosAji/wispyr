/**
 * Context Loader — loads WISPYR.md project context files.
 *
 * Searches for WISPYR.md in the working folder and parent directories,
 * providing project-specific instructions and context to the LLM.
 */
import { readFileSync, existsSync } from 'fs'
import { join, dirname, resolve } from 'path'

const MAX_CONTEXT_LENGTH = 8000 // chars, roughly ~2K tokens
const CONTEXT_FILENAMES = ['WISPYR.md', 'wispyr.md', 'WISPYR.txt', '.wispyr']

/** Cache to avoid re-reading files on every turn */
const _contextCache = new Map<string, { content: string; mtime: number }>()

/**
 * Load WISPYR.md context from the working folder and its parents.
 * Returns null if no context file is found.
 *
 * Search order (all combined):
 * 1. Working folder WISPYR.md
 * 2. Parent directories up to 3 levels (project root detection)
 */
export function loadWispyrContext(folder: string): string | null {
  const contextParts: string[] = []
  const resolvedFolder = resolve(folder)

  // Search current folder and up to 3 parent levels
  let current = resolvedFolder
  const searched: string[] = []

  for (let depth = 0; depth < 4; depth++) {
    if (searched.includes(current)) break
    searched.push(current)

    for (const filename of CONTEXT_FILENAMES) {
      const filePath = join(current, filename)
      const content = readContextFile(filePath)
      if (content) {
        const label = depth === 0 ? filename : `${filename} (from parent: ${current})`
        contextParts.push(`--- ${label} ---\n${content}`)
      }
    }

    const parent = dirname(current)
    if (parent === current) break // reached root
    current = parent
  }

  if (contextParts.length === 0) return null

  let combined = contextParts.join('\n\n')

  // Truncate if too long
  if (combined.length > MAX_CONTEXT_LENGTH) {
    combined = combined.substring(0, MAX_CONTEXT_LENGTH) + '\n\n[...truncated]'
  }

  return combined
}

/**
 * Read a context file with caching.
 * Returns null if file doesn't exist or is empty.
 */
function readContextFile(filePath: string): string | null {
  try {
    if (!existsSync(filePath)) return null

    // Check cache
    const { mtimeMs } = require('fs').statSync(filePath)
    const cached = _contextCache.get(filePath)
    if (cached && cached.mtime === mtimeMs) {
      return cached.content || null
    }

    const content = readFileSync(filePath, 'utf-8').trim()
    _contextCache.set(filePath, { content, mtime: mtimeMs })

    return content || null
  } catch {
    return null
  }
}

/** Clear the context cache (useful after file changes) */
export function clearContextCache(): void {
  _contextCache.clear()
}
