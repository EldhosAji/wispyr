/**
 * Plugin Loader — discovers and loads plugins from filesystem.
 *
 * Follows Claude Code's convention:
 *   plugin-dir/
 *   ├── plugin.json          # { name, version, description, author }
 *   ├── commands/             # Slash commands (*.md with YAML frontmatter)
 *   ├── agents/               # Agent definitions (*.md with YAML frontmatter)
 *   ├── skills/               # Skills (*/SKILL.md)
 *   └── hooks/                # hooks.json + scripts
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'fs'
import { join, basename, extname } from 'path'

// ─── Types ───

export interface PluginManifest {
  name: string
  version: string
  description?: string
  author?: string
  path: string
}

export interface PluginCommand {
  name: string
  description: string
  allowedTools?: string[]
  argumentHint?: string
  body: string         // Markdown instructions
  pluginName: string
}

export interface PluginAgent {
  name: string
  description: string
  tools: string[]
  model?: string
  color?: string
  systemPrompt: string
  pluginName: string
}

export interface PluginHook {
  event: string        // PreToolUse, PostToolUse, Stop, etc.
  type: string         // 'command'
  command: string
  timeout?: number
  pluginName: string
}

export interface LoadedPlugin {
  manifest: PluginManifest
  commands: PluginCommand[]
  agents: PluginAgent[]
  hooks: PluginHook[]
}

// ─── Discovery ───

/** Discover plugins from standard locations */
export function discoverPluginDirs(): string[] {
  const dirs: string[] = []
  const searchPaths = [
    // User's home .wispyr/plugins/
    join(process.env.USERPROFILE || process.env.HOME || '', '.wispyr', 'plugins'),
    // App data plugins
    join(process.env.APPDATA || '', 'wispyr-desktop', 'plugins'),
    // Project-local plugins
    '.wispyr/plugins',
  ]

  for (const searchPath of searchPaths) {
    try {
      if (!existsSync(searchPath)) continue
      for (const entry of readdirSync(searchPath)) {
        const fullPath = join(searchPath, entry)
        if (statSync(fullPath).isDirectory()) {
          dirs.push(fullPath)
        }
      }
    } catch { /* skip */ }
  }

  return dirs
}

/** Load a plugin from a directory */
export function loadPlugin(pluginDir: string): LoadedPlugin | null {
  try {
    // Read manifest
    const manifestPath = join(pluginDir, 'plugin.json')
    const claudePluginPath = join(pluginDir, '.claude-plugin', 'plugin.json')
    let manifest: PluginManifest

    if (existsSync(manifestPath)) {
      manifest = { ...JSON.parse(readFileSync(manifestPath, 'utf-8')), path: pluginDir }
    } else if (existsSync(claudePluginPath)) {
      manifest = { ...JSON.parse(readFileSync(claudePluginPath, 'utf-8')), path: pluginDir }
    } else {
      manifest = { name: basename(pluginDir), version: '1.0.0', path: pluginDir }
    }

    // Load commands
    const commands = loadCommands(pluginDir, manifest.name)

    // Load agents
    const agents = loadAgents(pluginDir, manifest.name)

    // Load hooks
    const hooks = loadHooks(pluginDir, manifest.name)

    console.log(`[Plugin] Loaded "${manifest.name}": ${commands.length} commands, ${agents.length} agents, ${hooks.length} hooks`)

    return { manifest, commands, agents, hooks }
  } catch (err: any) {
    console.log(`[Plugin] Failed to load ${pluginDir}: ${err.message}`)
    return null
  }
}

/** Load all plugins from discovered directories */
export function loadAllPlugins(): LoadedPlugin[] {
  const dirs = discoverPluginDirs()
  const plugins: LoadedPlugin[] = []

  for (const dir of dirs) {
    const plugin = loadPlugin(dir)
    if (plugin) plugins.push(plugin)
  }

  return plugins
}

// ─── Markdown Parsing ───

/** Parse YAML frontmatter from markdown content */
export function parseFrontmatter(content: string): { frontmatter: Record<string, any>; body: string } {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/)
  if (!match) return { frontmatter: {}, body: content }

  const yaml = match[1]
  const body = match[2]

  // Simple YAML parser (handles key: value pairs)
  const frontmatter: Record<string, any> = {}
  for (const line of yaml.split('\n')) {
    const kvMatch = line.match(/^(\w[\w-]*)\s*:\s*(.+)$/)
    if (kvMatch) {
      const key = kvMatch[1].trim()
      let value: any = kvMatch[2].trim()

      // Handle arrays (comma-separated or YAML list)
      if (value.startsWith('[') && value.endsWith(']')) {
        value = value.slice(1, -1).split(',').map((s: string) => s.trim())
      }
      // Handle booleans
      if (value === 'true') value = true
      if (value === 'false') value = false

      frontmatter[key] = value
    }
  }

  return { frontmatter, body: body.trim() }
}

// ─── Loaders ───

function loadCommands(pluginDir: string, pluginName: string): PluginCommand[] {
  const commandsDir = join(pluginDir, 'commands')
  if (!existsSync(commandsDir)) return []

  const commands: PluginCommand[] = []
  for (const file of readdirSync(commandsDir)) {
    if (extname(file) !== '.md') continue
    try {
      const content = readFileSync(join(commandsDir, file), 'utf-8')
      const { frontmatter, body } = parseFrontmatter(content)

      commands.push({
        name: basename(file, '.md'),
        description: frontmatter.description || basename(file, '.md'),
        allowedTools: frontmatter['allowed-tools']
          ? (typeof frontmatter['allowed-tools'] === 'string'
              ? frontmatter['allowed-tools'].split(',').map((s: string) => s.trim())
              : frontmatter['allowed-tools'])
          : undefined,
        argumentHint: frontmatter['argument-hint'],
        body,
        pluginName,
      })
    } catch { /* skip */ }
  }

  return commands
}

function loadAgents(pluginDir: string, pluginName: string): PluginAgent[] {
  const agentsDir = join(pluginDir, 'agents')
  if (!existsSync(agentsDir)) return []

  const agents: PluginAgent[] = []
  for (const file of readdirSync(agentsDir)) {
    if (extname(file) !== '.md') continue
    try {
      const content = readFileSync(join(agentsDir, file), 'utf-8')
      const { frontmatter, body } = parseFrontmatter(content)

      agents.push({
        name: frontmatter.name || basename(file, '.md'),
        description: frontmatter.description || '',
        tools: frontmatter.tools
          ? (typeof frontmatter.tools === 'string'
              ? frontmatter.tools.split(',').map((s: string) => s.trim())
              : frontmatter.tools)
          : [],
        model: frontmatter.model,
        color: frontmatter.color,
        systemPrompt: body,
        pluginName,
      })
    } catch { /* skip */ }
  }

  return agents
}

function loadHooks(pluginDir: string, pluginName: string): PluginHook[] {
  const hooksFile = join(pluginDir, 'hooks', 'hooks.json')
  if (!existsSync(hooksFile)) return []

  const hooks: PluginHook[] = []
  try {
    const config = JSON.parse(readFileSync(hooksFile, 'utf-8'))
    const hookDefs = config.hooks || {}

    for (const [event, entries] of Object.entries(hookDefs)) {
      if (!Array.isArray(entries)) continue
      for (const entry of entries as any[]) {
        const hookList = entry.hooks || [entry]
        for (const hook of hookList) {
          hooks.push({
            event,
            type: hook.type || 'command',
            command: (hook.command || '').replace('${CLAUDE_PLUGIN_ROOT}', pluginDir),
            timeout: hook.timeout || 10,
            pluginName,
          })
        }
      }
    }
  } catch { /* skip */ }

  return hooks
}
