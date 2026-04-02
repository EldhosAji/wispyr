/**
 * MCP Client — connects to Model Context Protocol servers via stdio.
 *
 * MCP servers expose tools, resources, and prompts via JSON-RPC over stdio.
 * This client manages the server lifecycle and tool invocation.
 */
import { spawn, type ChildProcess } from 'child_process'
import { registerTool, type ToolResult, type ToolContext } from '../agent/tool-registry'

// ─── Types ───

export interface MCPServerConfig {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
  disabled?: boolean
}

export interface MCPTool {
  name: string
  description: string
  inputSchema: any
}

interface MCPConnection {
  config: MCPServerConfig
  process: ChildProcess
  tools: MCPTool[]
  requestId: number
  pendingRequests: Map<number, { resolve: (data: any) => void; reject: (err: Error) => void }>
}

// ─── Active connections ───

const _connections = new Map<string, MCPConnection>()

// ─── Connect / Disconnect ───

export async function connectMCPServer(config: MCPServerConfig): Promise<MCPTool[]> {
  if (_connections.has(config.name)) {
    console.log(`[MCP] Already connected to ${config.name}`)
    return _connections.get(config.name)!.tools
  }

  console.log(`[MCP] Connecting to ${config.name}: ${config.command} ${(config.args || []).join(' ')}`)

  const proc = spawn(config.command, config.args || [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...(config.env || {}) },
    shell: true,
  })

  const conn: MCPConnection = {
    config,
    process: proc,
    tools: [],
    requestId: 0,
    pendingRequests: new Map(),
  }

  _connections.set(config.name, conn)

  // Handle stdout (JSON-RPC responses)
  let buffer = ''
  proc.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        if (msg.id !== undefined && conn.pendingRequests.has(msg.id)) {
          const pending = conn.pendingRequests.get(msg.id)!
          conn.pendingRequests.delete(msg.id)
          if (msg.error) {
            pending.reject(new Error(msg.error.message || 'MCP error'))
          } else {
            pending.resolve(msg.result)
          }
        }
      } catch { /* skip non-JSON lines */ }
    }
  })

  proc.stderr!.on('data', (chunk: Buffer) => {
    console.log(`[MCP:${config.name}] stderr: ${chunk.toString().trim()}`)
  })

  proc.on('exit', (code) => {
    console.log(`[MCP] Server ${config.name} exited with code ${code}`)
    _connections.delete(config.name)
  })

  // Initialize
  try {
    await sendRequest(conn, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'Wispyr', version: '0.1.0' },
    })

    // Send initialized notification
    sendNotification(conn, 'notifications/initialized', {})

    // List tools
    const result = await sendRequest(conn, 'tools/list', {})
    conn.tools = result.tools || []
    console.log(`[MCP] ${config.name}: ${conn.tools.length} tools available`)

    // Register each tool in Wispyr's tool registry
    for (const tool of conn.tools) {
      registerMCPTool(config.name, tool)
    }

    return conn.tools
  } catch (err: any) {
    console.log(`[MCP] Failed to initialize ${config.name}: ${err.message}`)
    disconnectMCPServer(config.name)
    throw err
  }
}

export function disconnectMCPServer(name: string): void {
  const conn = _connections.get(name)
  if (!conn) return
  try { conn.process.kill() } catch { /* ok */ }
  _connections.delete(name)
  console.log(`[MCP] Disconnected from ${name}`)
}

export function disconnectAll(): void {
  for (const name of _connections.keys()) {
    disconnectMCPServer(name)
  }
}

export function getConnectedServers(): string[] {
  return Array.from(_connections.keys())
}

// ─── Register MCP tool in Wispyr ───

function registerMCPTool(serverName: string, mcpTool: MCPTool): void {
  const toolName = `mcp.${serverName}.${mcpTool.name}`

  // Convert MCP input schema to Wispyr parameters
  const params = schemaToParams(mcpTool.inputSchema)

  registerTool({
    name: toolName,
    description: `[MCP:${serverName}] ${mcpTool.description || mcpTool.name}`,
    parameters: params,
    permissionLevel: 'write',
    concurrencySafe: false,
    async execute(callParams: Record<string, any>, _ctx: ToolContext): Promise<ToolResult> {
      const conn = _connections.get(serverName)
      if (!conn) {
        return { success: false, log: `MCP server "${serverName}" not connected`, result: '', error: 'Server not connected' }
      }

      try {
        const result = await sendRequest(conn, 'tools/call', {
          name: mcpTool.name,
          arguments: callParams,
        })

        const content = result.content?.map((c: any) => c.text || JSON.stringify(c)).join('\n') || JSON.stringify(result)
        return { success: true, log: content, result: content.substring(0, 500) }
      } catch (err: any) {
        return { success: false, log: `MCP call failed: ${err.message}`, result: '', error: err.message }
      }
    },
  })
}

// ─── JSON-RPC helpers ───

function sendRequest(conn: MCPConnection, method: string, params: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = ++conn.requestId
    conn.pendingRequests.set(id, { resolve, reject })

    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
    conn.process.stdin!.write(msg)

    // Timeout
    setTimeout(() => {
      if (conn.pendingRequests.has(id)) {
        conn.pendingRequests.delete(id)
        reject(new Error(`MCP request timeout: ${method}`))
      }
    }, 15000)
  })
}

function sendNotification(conn: MCPConnection, method: string, params: any): void {
  const msg = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'
  conn.process.stdin!.write(msg)
}

function schemaToParams(schema: any): Array<{ name: string; type: any; description: string; required?: boolean }> {
  if (!schema?.properties) return []
  const required = new Set(schema.required || [])
  return Object.entries(schema.properties).map(([name, prop]: [string, any]) => ({
    name,
    type: prop.type || 'string',
    description: prop.description || name,
    required: required.has(name),
  }))
}
