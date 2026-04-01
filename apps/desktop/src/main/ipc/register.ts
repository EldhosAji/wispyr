import { BrowserWindow, ipcMain, dialog, app } from 'electron'
import * as providersStore from '../store/providers.store'
import * as workflowsStore from '../store/workflows.store'
import * as auditStore from '../store/audit.store'
import * as tasksStore from '../store/tasks.store'
import * as pluginsStore from '../store/plugins.store'
import * as settingsStore from '../store/settings.store'
import { readFileSync, existsSync } from 'fs'
import { join, basename } from 'path'
import https from 'https'
import http from 'http'
import { initializeAgent } from '../agent/init'
import { runAgent, cleanupTask, type AgentEvent } from '../agent/engine'
import { fallbackParse } from '../agent/task-parser'
import { getTaskCost, getSessionCost, formatCost, formatTokens } from '../agent/cost-tracker'
import { getTool } from '../agent/tool-registry'
import * as fsSkill from '../skills/filesystem.skill'
import * as fileHandlers from '../skills/filehandlers'

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8)
}

function getMainWindow(): BrowserWindow | null {
  const wins = BrowserWindow.getAllWindows()
  return wins.length > 0 ? wins[0] : null
}

/** Try to reach an LLM provider endpoint */
async function testProviderConnection(provider: providersStore.ProviderConfig): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    try {
      const url = new URL(provider.baseUrl)

      let testPath = '/'
      const authHeaders: Record<string, string> = {}

      if (provider.type === 'ollama') {
        testPath = '/api/tags'
      } else if (provider.type === 'openai' || provider.type === 'custom') {
        testPath = '/v1/models'
        if (provider.apiKey) authHeaders['Authorization'] = `Bearer ${provider.apiKey}`
      } else if (provider.type === 'anthropic') {
        testPath = '/v1/messages'
        if (provider.apiKey) {
          authHeaders['x-api-key'] = provider.apiKey
          authHeaders['anthropic-version'] = '2023-06-01'
        }
      } else if (provider.type === 'azure') {
        testPath = `/openai/models?api-version=2024-02-01`
        if (provider.apiKey) authHeaders['api-key'] = provider.apiKey
      } else if (provider.type === 'gemini') {
        testPath = '/v1beta/models'
      } else if (provider.type === 'groq') {
        testPath = '/openai/v1/models'
        if (provider.apiKey) authHeaders['Authorization'] = `Bearer ${provider.apiKey}`
      }

      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: testPath,
        method: 'GET',
        timeout: 5000,
        headers: {
          ...authHeaders,
          ...(provider.customHeaders || {}),
        },
      }

      const transport = url.protocol === 'https:' ? https : http
      const req = transport.request(options, (res) => {
        if (res.statusCode && res.statusCode < 500) {
          resolve({ success: true })
        } else {
          resolve({ success: false, error: `Server returned status ${res.statusCode}` })
        }
      })

      req.on('error', (err) => {
        resolve({ success: false, error: err.message })
      })

      req.on('timeout', () => {
        req.destroy()
        resolve({ success: false, error: 'Connection timed out (5s)' })
      })

      req.end()
    } catch (err: any) {
      resolve({ success: false, error: err.message || 'Invalid URL' })
    }
  })
}

// ─── Legacy step execution (for fallback mode) ───

async function executeStepAction(step: tasksStore.TaskStep, folder: string, prevOutputs: string[]): Promise<fsSkill.SkillResult> {
  let actionData: any = {}
  try {
    actionData = step.result ? JSON.parse(step.result) : {}
  } catch { /* parse failed */ }

  const action = actionData.action || ''
  const rawFileName = actionData.fileName || 'output.txt'
  const fileName = basename(rawFileName)
  const filePath = join(folder, fileName)

  switch (action) {
    case 'write_file': {
      if (fileHandlers.isRichFileType(fileName)) {
        return await fileHandlers.writeRichFile(filePath, actionData.data || actionData)
      }
      return fsSkill.writeFile(folder, fileName, actionData.content || '')
    }
    case 'read_file': {
      if (fileHandlers.isRichFileType(fileName)) {
        return await fileHandlers.readRichFile(filePath)
      }
      return fsSkill.readFile(folder, fileName)
    }
    case 'list_dir': return fsSkill.listDir(folder)
    case 'create_dir': return fsSkill.createDir(folder, actionData.dirName || 'new_folder')
    case 'delete_file': return fsSkill.deleteFile(folder, fileName)
    case 'move_file': return fsSkill.moveFile(folder, actionData.from || '', actionData.to || '')
    case 'copy_file': return fsSkill.copyFile(folder, actionData.from || '', actionData.to || '')
    case 'search_files': return fsSkill.searchFiles(folder, actionData.pattern || '')
    case 'organise': return fsSkill.organiseFolder(folder)
    case 'append_file': return fsSkill.appendFile(folder, fileName, actionData.content || '')
    default:
      return { success: true, log: `Executed: ${step.title}`, result: step.description }
  }
}

// Permission response tracking
const pendingPermissions = new Map<string, { resolve: (approved: boolean) => void }>()

function waitForPermission(stepId: string): Promise<boolean> {
  return new Promise((resolve) => {
    pendingPermissions.set(stepId, { resolve })
    setTimeout(() => {
      if (pendingPermissions.has(stepId)) {
        pendingPermissions.delete(stepId)
        resolve(false)
      }
    }, 120000)
  })
}

// Active agent abort controllers
const activeAgents = new Map<string, AbortController>()

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function registerAllIpcHandlers(_mainWindow: BrowserWindow | null): void {
  // Initialize the agent tool registry on startup
  initializeAgent()

  // ═══════════════════════════════════════════════
  // AGENT (new agentic engine)
  // ═══════════════════════════════════════════════

  ipcMain.handle('agent:run', async (_event, task: string, folder: string) => {
    const taskId = generateId()
    const mainWindow = getMainWindow()
    const activeProvider = providersStore.getActiveProvider()

    // Create task record
    const newTask: tasksStore.Task = {
      id: taskId,
      description: task,
      folder,
      status: 'planning',
      steps: [],
      createdAt: new Date().toISOString(),
    }
    tasksStore.addTask(newTask)

    auditStore.appendAudit({
      taskId,
      skill: 'agent',
      action: 'task_started',
      params: JSON.stringify({ task, folder }),
      permission: 'auto-approved',
    })

    // If no provider, use fallback parser
    if (!activeProvider) {
      const steps = fallbackParse(task)
      tasksStore.updateTask(taskId, { status: 'awaiting_approval', steps })
      return {
        taskId,
        mode: 'legacy',
        plan: { id: generateId(), taskId, task, folder, createdAt: new Date().toISOString(), steps },
      }
    }

    // Use the new agent engine
    const abortController = new AbortController()
    activeAgents.set(taskId, abortController)

    tasksStore.updateTask(taskId, { status: 'running' })
    if (mainWindow) {
      mainWindow.webContents.send('agent:status', { taskId, status: 'running' })
    }

    // Return taskId first, then start agent after a microtask
    // so the renderer has time to set up the stream listener
    setTimeout(() => {
    runAgent({
      taskId,
      folder,
      provider: activeProvider,
      message: task,
      stream: true,
      maxTurns: 15,
      abortSignal: abortController.signal,
      onEvent: (event: AgentEvent) => {
        console.log(`[IPC] Agent event: type=${event.type}, taskId=${taskId}, text=${event.text?.substring(0, 50) || ''}, error=${event.error || ''}`)
        if (!mainWindow) {
          console.log(`[IPC] WARNING: mainWindow is null, cannot send event`)
          return
        }

        switch (event.type) {
          case 'thinking':
            mainWindow.webContents.send('agent:stream', { taskId, type: 'thinking' })
            break

          case 'text_delta':
            mainWindow.webContents.send('agent:stream', { taskId, type: 'text_delta', text: event.text })
            break

          case 'text_done':
            mainWindow.webContents.send('agent:stream', { taskId, type: 'text_done', text: event.text })
            break

          case 'tool_start':
            mainWindow.webContents.send('agent:stream', {
              taskId, type: 'tool_start',
              toolCall: event.toolCall,
            })
            break

          case 'tool_result':
            mainWindow.webContents.send('agent:stream', {
              taskId, type: 'tool_result',
              toolResult: event.toolResult,
            })

            // Also update task steps for history
            if (event.toolResult) {
              const currentTask = tasksStore.getTask(taskId)
              const steps = currentTask?.steps || []
              steps.push({
                id: event.toolResult.toolCallId,
                title: event.toolResult.name || 'Tool',
                description: event.toolResult.result.log.substring(0, 100),
                skills: [event.toolResult.name],
                permissionLevel: event.toolResult.permissionLevel,
                status: event.toolResult.result.success ? 'success' : 'error',
                result: event.toolResult.result.result,
                log: event.toolResult.result.log,
                error: event.toolResult.result.error,
                completedAt: new Date().toISOString(),
              })
              tasksStore.updateTask(taskId, { steps })
            }
            break

          case 'permission_needed':
            mainWindow.webContents.send('permission:request', {
              id: generateId(),
              taskId,
              stepId: event.toolCall?.id || generateId(),
              action: event.toolCall?.name || 'unknown',
              level: getTool(event.toolCall?.name || '')?.permissionLevel || 'write',
              humanDescription: `${event.toolCall?.name}: ${JSON.stringify(event.toolCall?.arguments || {}).substring(0, 200)}`,
              details: event.toolCall?.arguments,
            })
            break

          case 'cost_update':
            mainWindow.webContents.send('agent:stream', {
              taskId, type: 'cost_update',
              cost: getTaskCost(taskId),
            })
            break

          case 'error':
            mainWindow.webContents.send('agent:stream', { taskId, type: 'error', error: event.error })
            break

          case 'task_complete':
            tasksStore.updateTask(taskId, { status: 'completed', completedAt: new Date().toISOString() })
            mainWindow.webContents.send('agent:stream', {
              taskId, type: 'task_complete',
              text: event.text,
              cost: getTaskCost(taskId),
            })
            mainWindow.webContents.send('agent:status', { taskId, status: 'completed' })
            activeAgents.delete(taskId)
            break

          case 'compacting':
            mainWindow.webContents.send('agent:stream', { taskId, type: 'compacting' })
            break

          case 'skill_generating':
            mainWindow.webContents.send('agent:stream', { taskId, type: 'skill_generating', text: event.text })
            break
        }
      },
      onPermission: async (toolCall, level) => {
        return await waitForPermission(toolCall.id)
      },
    }).catch((err) => {
      tasksStore.updateTask(taskId, { status: 'failed', error: err.message })
      if (mainWindow) {
        mainWindow.webContents.send('agent:stream', { taskId, type: 'error', error: err.message })
        mainWindow.webContents.send('agent:status', { taskId, status: 'failed' })
      }
      activeAgents.delete(taskId)
    })
    }, 50) // Small delay to let renderer set up stream listener

    return { taskId, mode: 'agent' }
  })

  // ─── Follow-up message (multi-turn) ───
  ipcMain.handle('agent:followup', async (_event, taskId: string, message: string) => {
    const mainWindow = getMainWindow()
    const activeProvider = providersStore.getActiveProvider()
    const task = tasksStore.getTask(taskId)

    if (!activeProvider || !task) {
      return { success: false, error: 'No active provider or task not found' }
    }

    const abortController = new AbortController()
    activeAgents.set(taskId, abortController)
    tasksStore.updateTask(taskId, { status: 'running' })

    runAgent({
      taskId,
      folder: task.folder,
      provider: activeProvider,
      message,
      stream: true,
      isFollowUp: true,
      abortSignal: abortController.signal,
      onEvent: (event: AgentEvent) => {
        if (!mainWindow) return
        // Same event handling as agent:run
        switch (event.type) {
          case 'text_delta':
            mainWindow.webContents.send('agent:stream', { taskId, type: 'text_delta', text: event.text })
            break
          case 'text_done':
            mainWindow.webContents.send('agent:stream', { taskId, type: 'text_done', text: event.text })
            break
          case 'tool_start':
            mainWindow.webContents.send('agent:stream', { taskId, type: 'tool_start', toolCall: event.toolCall })
            break
          case 'tool_result':
            mainWindow.webContents.send('agent:stream', { taskId, type: 'tool_result', toolResult: event.toolResult })
            break
          case 'permission_needed':
            mainWindow.webContents.send('permission:request', {
              id: generateId(), taskId, stepId: event.toolCall?.id || generateId(),
              action: event.toolCall?.name || 'unknown',
              level: getTool(event.toolCall?.name || '')?.permissionLevel || 'write',
              humanDescription: `${event.toolCall?.name}: ${JSON.stringify(event.toolCall?.arguments || {}).substring(0, 200)}`,
              details: event.toolCall?.arguments,
            })
            break
          case 'cost_update':
            mainWindow.webContents.send('agent:stream', { taskId, type: 'cost_update', cost: getTaskCost(taskId) })
            break
          case 'error':
            mainWindow.webContents.send('agent:stream', { taskId, type: 'error', error: event.error })
            break
          case 'task_complete':
            tasksStore.updateTask(taskId, { status: 'completed', completedAt: new Date().toISOString() })
            mainWindow.webContents.send('agent:stream', { taskId, type: 'task_complete', text: event.text, cost: getTaskCost(taskId) })
            activeAgents.delete(taskId)
            break
        }
      },
      onPermission: async (toolCall, level) => {
        return await waitForPermission(toolCall.id)
      },
    }).catch((err) => {
      if (mainWindow) {
        mainWindow.webContents.send('agent:stream', { taskId, type: 'error', error: err.message })
      }
      activeAgents.delete(taskId)
    })

    return { success: true }
  })

  ipcMain.handle('agent:cancel', async (_event, taskId: string) => {
    const controller = activeAgents.get(taskId)
    if (controller) {
      controller.abort()
      activeAgents.delete(taskId)
    }
    tasksStore.updateTask(taskId, { status: 'cancelled' })
    cleanupTask(taskId)
    const mainWindow = getMainWindow()
    if (mainWindow) {
      mainWindow.webContents.send('agent:status', { taskId, status: 'cancelled' })
    }
    auditStore.appendAudit({
      taskId, skill: 'agent', action: 'task_cancelled',
      params: JSON.stringify({ taskId }), permission: 'auto-approved',
    })
    return { success: true }
  })

  // ─── Cost ───
  ipcMain.handle('cost:task', async (_event, taskId: string) => {
    return getTaskCost(taskId)
  })

  ipcMain.handle('cost:session', async () => {
    return getSessionCost()
  })

  // ═══════════════════════════════════════════════
  // PLAN (legacy — kept for fallback mode)
  // ═══════════════════════════════════════════════

  ipcMain.handle('plan:approve', async (_event, taskId: string, editedSteps?: any[]) => {
    const currentTask = tasksStore.getTask(taskId)
    const steps = editedSteps || currentTask?.steps || []

    // Execute via legacy path
    executeLegacyPlan(taskId, steps)
    return { success: true }
  })

  ipcMain.handle('plan:reject', async (_event, taskId: string) => {
    tasksStore.updateTask(taskId, { status: 'cancelled' })
    return { success: true }
  })

  // ─── Permission ───
  ipcMain.handle('permission:respond', async (_event, stepId: string, approved: boolean, _remember: boolean) => {
    const pending = pendingPermissions.get(stepId)
    if (pending) {
      pending.resolve(approved)
      pendingPermissions.delete(stepId)
    }
    return { success: true }
  })

  // ═══════════════════════════════════════════════
  // PROVIDERS
  // ═══════════════════════════════════════════════

  ipcMain.handle('providers:list', async () => {
    const providers = providersStore.getProvidersSafe()
    const activeId = providersStore.getActiveProviderId()
    return providers.map((p) => ({ ...p, isActive: p.id === activeId }))
  })

  ipcMain.handle('providers:add', async (_event, provider: any) => {
    const config: providersStore.ProviderConfig = {
      id: generateId(), name: provider.name, type: provider.type,
      baseUrl: provider.baseUrl, model: provider.model,
      apiKey: provider.apiKey || undefined,
      customHeaders: provider.customHeaders || undefined,
      fallbackPriority: provider.fallbackPriority,
    }
    providersStore.addProvider(config)
    auditStore.appendAudit({
      skill: 'providers', action: 'provider_added',
      params: JSON.stringify({ name: config.name, type: config.type, model: config.model }),
      permission: 'auto-approved',
    })
    return { success: true, provider: { ...config, apiKey: undefined, hasApiKey: !!config.apiKey } }
  })

  ipcMain.handle('providers:remove', async (_event, id: string) => {
    const provider = providersStore.getProviders().find((p) => p.id === id)
    providersStore.removeProvider(id)
    auditStore.appendAudit({
      skill: 'providers', action: 'provider_removed',
      params: JSON.stringify({ id, name: provider?.name }),
      permission: 'auto-approved',
    })
    return { success: true }
  })

  ipcMain.handle('providers:test', async (_event, id: string) => {
    const provider = providersStore.getProviders().find((p) => p.id === id)
    if (!provider) return { success: false, error: 'Provider not found' }
    return await testProviderConnection(provider)
  })

  ipcMain.handle('providers:setActive', async (_event, id: string) => {
    providersStore.setActiveProvider(id)
    return { success: true }
  })

  ipcMain.handle('providers:models', async (_event, id: string) => {
    const provider = providersStore.getProviders().find((p) => p.id === id)
    if (!provider) return []
    switch (provider.type) {
      case 'ollama': return ['llama3.1', 'llama3.2', 'mistral', 'codellama', 'phi3', 'gemma2']
      case 'openai': return ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo']
      case 'anthropic': return ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001']
      case 'gemini': return ['gemini-2.0-flash', 'gemini-2.0-pro', 'gemini-1.5-pro']
      case 'azure': return ['gpt-4o', 'gpt-4o-mini', 'gpt-4', 'gpt-4-turbo', 'gpt-35-turbo']
      case 'groq': return ['llama-3.1-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768']
      default: return [provider.model]
    }
  })

  ipcMain.handle('providers:getActive', async () => {
    const provider = providersStore.getActiveProvider()
    if (!provider) return null
    return { ...provider, apiKey: undefined, hasApiKey: !!provider.apiKey, isActive: true }
  })

  // ═══════════════════════════════════════════════
  // PLUGINS
  // ═══════════════════════════════════════════════

  ipcMain.handle('plugins:list', async () => pluginsStore.getPlugins())

  ipcMain.handle('plugins:install', async (_event, nameOrPath: string) => {
    const id = generateId()
    pluginsStore.installPlugin({
      id, name: nameOrPath.split('/').pop() || nameOrPath,
      version: '1.0.0', description: `Plugin installed from ${nameOrPath}`,
      author: 'Community', enabled: true, type: 'skill',
    })
    auditStore.appendAudit({ skill: 'plugins', action: 'plugin_installed', params: JSON.stringify({ source: nameOrPath }), permission: 'auto-approved' })
    return { success: true, id }
  })

  ipcMain.handle('plugins:toggle', async (_event, id: string, enabled: boolean) => {
    return { success: pluginsStore.togglePlugin(id, enabled) }
  })

  ipcMain.handle('plugins:remove', async (_event, id: string) => {
    return { success: pluginsStore.removePlugin(id) }
  })

  ipcMain.handle('plugins:discover', async () => {
    const discovered: any[] = []
    const homedir = app.getPath('home')
    const mcpLocations = [
      join(homedir, '.config', 'mcp', 'servers.json'),
      join(homedir, 'AppData', 'Roaming', 'mcp', 'servers.json'),
      join(homedir, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json'),
    ]
    for (const loc of mcpLocations) {
      try {
        if (existsSync(loc)) {
          const data = JSON.parse(readFileSync(loc, 'utf-8'))
          const servers = data.mcpServers || data.servers || {}
          for (const [name, config] of Object.entries(servers)) {
            discovered.push({ id: `mcp-${name}`, name: `MCP: ${name}`, source: loc, config })
          }
        }
      } catch { /* skip */ }
    }
    return discovered
  })

  // ═══════════════════════════════════════════════
  // WORKFLOWS
  // ═══════════════════════════════════════════════

  ipcMain.handle('workflows:list', async () => workflowsStore.getWorkflows())

  ipcMain.handle('workflows:run', async (_event, id: string, inputs: any) => {
    const workflow = workflowsStore.getWorkflow(id)
    if (!workflow) return { success: false, error: 'Workflow not found' }
    workflowsStore.saveWorkflow({ ...workflow, lastRun: new Date().toISOString() })
    auditStore.appendAudit({ skill: 'workflows', action: 'workflow_run', params: JSON.stringify({ workflowId: id, name: workflow.name, inputs }), permission: 'auto-approved' })
    return { success: true }
  })

  ipcMain.handle('workflows:save', async (_event, workflow: any) => {
    const toSave: workflowsStore.Workflow = {
      id: workflow.id || generateId(), name: workflow.name,
      description: workflow.description || '', author: workflow.author || 'User',
      version: workflow.version || '1.0.0', inputs: workflow.inputs || [],
      steps: workflow.steps || [], createdAt: workflow.createdAt || new Date().toISOString(),
      lastRun: workflow.lastRun,
    }
    workflowsStore.saveWorkflow(toSave)
    auditStore.appendAudit({ skill: 'workflows', action: 'workflow_saved', params: JSON.stringify({ id: toSave.id, name: toSave.name }), permission: 'auto-approved' })
    return { success: true, workflow: toSave }
  })

  ipcMain.handle('workflows:delete', async (_event, id: string) => {
    workflowsStore.deleteWorkflow(id)
    auditStore.appendAudit({ skill: 'workflows', action: 'workflow_deleted', params: JSON.stringify({ id }), permission: 'auto-approved' })
    return { success: true }
  })

  ipcMain.handle('workflows:import', async (_event, filePath?: string) => {
    let targetPath = filePath
    if (!targetPath) {
      const result = await dialog.showOpenDialog({ title: 'Import Workflow', filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile'] })
      if (result.canceled || result.filePaths.length === 0) return { success: false, error: 'Cancelled' }
      targetPath = result.filePaths[0]
    }
    try {
      const raw = readFileSync(targetPath!, 'utf-8')
      const data = JSON.parse(raw)
      const workflow: workflowsStore.Workflow = {
        id: data.id || generateId(), name: data.name || 'Imported Workflow',
        description: data.description || '', author: data.author || 'Imported',
        version: data.version || '1.0.0', inputs: data.inputs || [],
        steps: data.steps || [], createdAt: new Date().toISOString(),
      }
      workflowsStore.saveWorkflow(workflow)
      return { success: true, workflow }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ═══════════════════════════════════════════════
  // AUDIT, TASKS, SETTINGS, FS, WINDOW
  // ═══════════════════════════════════════════════

  ipcMain.handle('audit:list', async (_event, filter?: any) => auditStore.getAuditEntries(filter))

  ipcMain.handle('audit:export', async (_event, format: 'csv' | 'json') => {
    const data = auditStore.exportAudit(format)
    const ext = format === 'csv' ? 'csv' : 'json'
    const result = await dialog.showSaveDialog({
      title: `Export Audit Log as ${format.toUpperCase()}`,
      defaultPath: `wispyr-audit-${new Date().toISOString().slice(0, 10)}.${ext}`,
      filters: [{ name: format.toUpperCase(), extensions: [ext] }],
    })
    if (!result.canceled && result.filePath) {
      const { writeFileSync } = await import('fs')
      writeFileSync(result.filePath, data, 'utf-8')
      return { success: true, filePath: result.filePath }
    }
    return { success: false, data }
  })

  ipcMain.handle('tasks:list', async () => tasksStore.getTasks())
  ipcMain.handle('tasks:get', async (_event, id: string) => tasksStore.getTask(id))

  ipcMain.handle('settings:get', async () => settingsStore.getSettings())
  ipcMain.handle('settings:update', async (_event, updates: any) => {
    settingsStore.updateSettings(updates)
    return { success: true }
  })

  ipcMain.handle('fs:pickFolder', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('window:minimize', async (event) => { BrowserWindow.fromWebContents(event.sender)?.minimize() })
  ipcMain.handle('window:maximize', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win?.isMaximized()) win.unmaximize()
    else win?.maximize()
  })
  ipcMain.handle('window:close', async (event) => { BrowserWindow.fromWebContents(event.sender)?.close() })
}

// ═══════════════════════════════════════════════
// Legacy plan execution (fallback when no LLM)
// ═══════════════════════════════════════════════

async function executeLegacyPlan(taskId: string, steps: tasksStore.TaskStep[]): Promise<void> {
  const mainWindow = getMainWindow()
  if (!mainWindow) return

  const task = tasksStore.getTask(taskId)
  const folder = task?.folder || ''

  tasksStore.updateTask(taskId, { status: 'running', steps })
  mainWindow.webContents.send('agent:status', { taskId, status: 'running' })

  const stepOutputs: string[] = []
  let hasError = false

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    const currentTask = tasksStore.getTask(taskId)
    if (currentTask?.status === 'cancelled') {
      mainWindow.webContents.send('agent:complete', { taskId, success: false, steps, error: 'Cancelled by user' })
      return
    }

    step.status = 'running'
    step.startedAt = new Date().toISOString()
    step.log = `Executing: ${step.title}...`
    const actionJson = step.result
    step.result = undefined
    tasksStore.updateTask(taskId, { steps })
    mainWindow.webContents.send('agent:step', { taskId, stepIndex: i, step })
    step.result = actionJson

    if (step.permissionLevel !== 'read_only') {
      mainWindow.webContents.send('permission:request', {
        id: generateId(), taskId, stepId: step.id,
        action: step.skills[0] || 'unknown', level: step.permissionLevel,
        humanDescription: `${step.title}: ${step.description}`,
        details: { step: i + 1, total: steps.length },
      })
      const approved = await waitForPermission(step.id)
      auditStore.appendAudit({ taskId, skill: step.skills[0]?.split('.')[0] || 'agent', action: step.skills[0] || step.title, params: JSON.stringify({ description: step.description }), permission: approved ? 'approved' : 'denied' })

      if (!approved) {
        step.status = 'skipped'
        step.completedAt = new Date().toISOString()
        step.log = 'Skipped: permission denied'
        step.result = 'Skipped'
        tasksStore.updateTask(taskId, { steps })
        mainWindow.webContents.send('agent:step', { taskId, stepIndex: i, step })
        continue
      }
    } else {
      auditStore.appendAudit({ taskId, skill: step.skills[0]?.split('.')[0] || 'agent', action: step.skills[0] || step.title, params: JSON.stringify({ description: step.description }), permission: 'auto-approved' })
    }

    await sleep(200)
    const output = await executeStepAction(step, folder, stepOutputs)
    step.completedAt = new Date().toISOString()
    step.log = output.log
    step.result = output.result

    if (output.success) {
      step.status = 'success'
      stepOutputs.push(output.log)
    } else {
      step.status = 'error'
      step.error = output.error
      hasError = true
    }

    tasksStore.updateTask(taskId, { steps })
    mainWindow.webContents.send('agent:step', { taskId, stepIndex: i, step })
  }

  const completedSteps = steps.filter(s => s.status === 'success').length
  const allFailed = completedSteps === 0
  const writeStepsSucceeded = steps.some(s => s.status === 'success' && s.permissionLevel !== 'read_only')
  const taskSuccess = !allFailed && (writeStepsSucceeded || !hasError)
  const completedAt = new Date().toISOString()

  tasksStore.updateTask(taskId, { status: taskSuccess ? 'completed' : 'failed', completedAt })
  mainWindow.webContents.send('agent:complete', { taskId, success: taskSuccess, steps, completedAt })
  mainWindow.webContents.send('agent:status', { taskId, status: taskSuccess ? 'completed' : 'failed' })
}
