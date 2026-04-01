import { BrowserWindow, ipcMain, dialog, app } from 'electron'
import * as providersStore from '../store/providers.store'
import * as workflowsStore from '../store/workflows.store'
import * as auditStore from '../store/audit.store'
import * as tasksStore from '../store/tasks.store'
import * as pluginsStore from '../store/plugins.store'
import * as settingsStore from '../store/settings.store'
import { readFileSync, existsSync, readdirSync, statSync } from 'fs'
import { join, extname, basename } from 'path'
import https from 'https'
import http from 'http'
import { planTask } from '../agent/task-parser'
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

      // For Ollama, hit /api/tags. For others, just try to connect.
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

/** Generate a plan using the LLM (or fallback). Returns the plan object. */
async function generatePlan(
  task: string,
  folder: string,
  taskId: string,
): Promise<{ id: string; taskId: string; task: string; folder: string; createdAt: string; steps: tasksStore.TaskStep[] }> {
  const activeProvider = providersStore.getActiveProvider()

  tasksStore.updateTask(taskId, { status: 'planning' })

  const steps = await planTask(task, folder, activeProvider)

  const plan = {
    id: generateId(),
    taskId,
    task,
    folder,
    createdAt: new Date().toISOString(),
    steps,
  }

  tasksStore.updateTask(taskId, { status: 'awaiting_approval', steps: plan.steps })

  auditStore.appendAudit({
    taskId,
    skill: 'agent',
    action: 'plan_created',
    params: JSON.stringify({ task, folder, stepCount: plan.steps.length, usedLLM: !!activeProvider }),
    result: JSON.stringify({ planId: plan.id }),
    permission: 'auto-approved',
  })

  return plan
}

// Removed — now using async planTask() from task-parser.ts

/** Execute a single step's action using filesystem skill + rich file handlers */
async function executeStepAction(step: tasksStore.TaskStep, folder: string, prevOutputs: string[]): Promise<fsSkill.SkillResult> {
  let actionData: any = {}
  try {
    actionData = step.result ? JSON.parse(step.result) : {}
  } catch { /* parse failed, use empty */ }

  const action = actionData.action || ''
  // Ensure fileName is just the basename, not a full path (LLM sometimes returns full paths)
  const rawFileName = actionData.fileName || 'output.txt'
  const fileName = basename(rawFileName)
  const filePath = join(folder, fileName)

  switch (action) {
    case 'write_file':
    case 'write_excel':
    case 'write_docx':
    case 'write_pdf':
    case 'write_pptx':
    case 'write_csv':
    case 'write_zip':
    case 'write_yaml': {
      // Route to rich handler for binary/structured types
      if (fileHandlers.isRichFileType(fileName)) {
        // For rich files, actionData should contain structured data from the LLM
        const richData = actionData.data || actionData
        return await fileHandlers.writeRichFile(filePath, richData)
      }
      // Plain text
      return fsSkill.writeFile(folder, fileName, actionData.content || '')
    }

    case 'read_file': {
      if (fileHandlers.isRichFileType(fileName)) {
        return await fileHandlers.readRichFile(filePath)
      }
      return fsSkill.readFile(folder, fileName)
    }

    case 'list_dir':
      return fsSkill.listDir(folder)

    case 'create_dir':
      return fsSkill.createDir(folder, actionData.dirName || 'new_folder')

    case 'delete_file':
      return fsSkill.deleteFile(folder, fileName)

    case 'move_file':
      return fsSkill.moveFile(folder, actionData.from || '', actionData.to || '')

    case 'copy_file':
      return fsSkill.copyFile(folder, actionData.from || '', actionData.to || '')

    case 'search_files':
      return fsSkill.searchFiles(folder, actionData.pattern || '')

    case 'organise':
      return fsSkill.organiseFolder(folder)

    case 'append_file':
      return fsSkill.appendFile(folder, fileName, actionData.content || '')

    case 'write_summary': {
      const summaryContent = [
        `# Folder Summary`,
        ``,
        `Folder: ${folder}`,
        `Generated: ${new Date().toISOString()}`,
        ``,
        ...prevOutputs.map((o, i) => `## Step ${i + 1}\n${o}\n`),
      ].join('\n')
      return fsSkill.writeFile(folder, 'summary.md', summaryContent)
    }

    case 'generic':
      return fsSkill.listDir(folder)

    default: {
      // Try to infer from filename extension
      if (fileHandlers.isRichFileType(fileName) && actionData.data) {
        return await fileHandlers.writeRichFile(filePath, actionData.data)
      }
      const skill = step.skills[0] || ''
      if (skill.includes('list_dir')) return fsSkill.listDir(folder)
      if (skill.includes('read_file')) {
        if (fileHandlers.isRichFileType(fileName)) return await fileHandlers.readRichFile(filePath)
        return fsSkill.readFile(folder, fileName)
      }
      if (skill.includes('write_file')) return fsSkill.writeFile(folder, fileName, actionData.content || '')
      if (skill.includes('search')) return fsSkill.searchFiles(folder, actionData.pattern || '*')

      return { success: true, log: `Executed: ${step.title}\nFolder: ${folder}`, result: step.description }
    }
  }
}

async function executeApprovedPlan(taskId: string, steps: tasksStore.TaskStep[]): Promise<void> {
  const mainWindow = getMainWindow()
  if (!mainWindow) return

  const task = tasksStore.getTask(taskId)
  const folder = task?.folder || ''
  const taskDescription = task?.description || ''

  tasksStore.updateTask(taskId, { status: 'running', steps })
  mainWindow.webContents.send('agent:status', { taskId, status: 'running' })

  const stepOutputs: string[] = []
  let hasError = false

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]

    // Check cancellation
    const currentTask = tasksStore.getTask(taskId)
    if (currentTask?.status === 'cancelled') {
      mainWindow.webContents.send('agent:complete', {
        taskId, success: false, steps, startedAt: currentTask.createdAt,
        completedAt: new Date().toISOString(), error: 'Cancelled by user',
      })
      return
    }

    // Mark step running
    step.status = 'running'
    step.startedAt = new Date().toISOString()
    step.log = `Executing: ${step.title}...`
    // Clear the action data from result (was used for planning)
    const actionJson = step.result
    step.result = undefined
    tasksStore.updateTask(taskId, { steps })
    mainWindow.webContents.send('agent:step', { taskId, stepIndex: i, step })
    // Restore for execution
    step.result = actionJson

    // Permission check
    if (step.permissionLevel !== 'read_only') {
      mainWindow.webContents.send('permission:request', {
        id: generateId(),
        taskId,
        stepId: step.id,
        action: step.skills[0] || 'unknown',
        level: step.permissionLevel,
        humanDescription: `${step.title}: ${step.description}`,
        details: { step: i + 1, total: steps.length },
      })
      const approved = await waitForPermission(step.id)

      auditStore.appendAudit({
        taskId,
        skill: step.skills[0]?.split('.')[0] || 'agent',
        action: step.skills[0] || step.title,
        params: JSON.stringify({ description: step.description }),
        permission: approved ? 'approved' : 'denied',
      })

      if (!approved) {
        step.status = 'skipped'
        step.completedAt = new Date().toISOString()
        step.log = `⊘ Skipped: permission denied by user`
        step.result = 'Skipped'
        tasksStore.updateTask(taskId, { steps })
        mainWindow.webContents.send('agent:step', { taskId, stepIndex: i, step })
        continue
      }
    } else {
      auditStore.appendAudit({
        taskId,
        skill: step.skills[0]?.split('.')[0] || 'agent',
        action: step.skills[0] || step.title,
        params: JSON.stringify({ description: step.description }),
        permission: 'auto-approved',
      })
    }

    // ─── REAL EXECUTION ───
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

  // Completion — consider task successful if at least one write step succeeded
  const completedSteps = steps.filter(s => s.status === 'success').length
  const skippedSteps = steps.filter(s => s.status === 'skipped').length
  const errorSteps = steps.filter(s => s.status === 'error').length
  const completedAt = new Date().toISOString()

  // A task is "successful" if any write/create step completed, even if read/search steps failed
  const writeStepsSucceeded = steps.some(s => s.status === 'success' && s.permissionLevel !== 'read_only')
  const allFailed = completedSteps === 0
  const taskSuccess = !allFailed && (writeStepsSucceeded || !hasError)

  const summaryLines = [
    `Task: "${taskDescription}"`,
    `Folder: ${folder}`,
    `Steps: ${completedSteps} completed, ${skippedSteps} skipped, ${errorSteps} errors, ${steps.length} total`,
    '',
    '── Results ──',
  ]
  for (const s of steps) {
    const icon = s.status === 'success' ? '✓' : s.status === 'skipped' ? '⊘' : '✗'
    summaryLines.push(`${icon} ${s.title}: ${s.result || s.status}`)
  }

  const finalStatus = taskSuccess ? 'completed' : 'failed'
  tasksStore.updateTask(taskId, { status: finalStatus, completedAt })
  mainWindow.webContents.send('agent:complete', {
    taskId, success: taskSuccess, steps,
    startedAt: task?.createdAt,
    completedAt,
    summary: summaryLines.join('\n'),
  })
  mainWindow.webContents.send('agent:status', { taskId, status: finalStatus })
}

// Permission response tracking
const pendingPermissions = new Map<string, { resolve: (approved: boolean) => void }>()

function waitForPermission(stepId: string): Promise<boolean> {
  return new Promise((resolve) => {
    pendingPermissions.set(stepId, { resolve })
    // Auto-timeout after 60s
    setTimeout(() => {
      if (pendingPermissions.has(stepId)) {
        pendingPermissions.delete(stepId)
        resolve(false)
      }
    }, 60000)
  })
}

// Plan approval tracking
const pendingPlanApprovals = new Map<string, { resolve: (data: { approved: boolean; steps?: any[] }) => void }>()

function waitForPlanApproval(taskId: string): Promise<{ approved: boolean; steps?: any[] }> {
  return new Promise((resolve) => {
    pendingPlanApprovals.set(taskId, { resolve })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function registerAllIpcHandlers(_mainWindow: BrowserWindow | null): void {
  // ─── Agent ───
  ipcMain.handle('agent:run', async (_event, task: string, folder: string) => {
    const taskId = generateId()
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

    // Generate plan (calls LLM — may take a few seconds)
    // We AWAIT this so the renderer gets the plan in the response
    const plan = await generatePlan(task, folder, taskId)

    // Return the plan to the renderer — it will show plan preview
    return { taskId, plan }
  })

  ipcMain.handle('agent:cancel', async (_event, taskId: string) => {
    tasksStore.updateTask(taskId, { status: 'cancelled' })
    const mainWindow = getMainWindow()
    if (mainWindow) {
      mainWindow.webContents.send('agent:status', { taskId, status: 'cancelled' })
    }
    auditStore.appendAudit({
      taskId,
      skill: 'agent',
      action: 'task_cancelled',
      params: JSON.stringify({ taskId }),
      permission: 'auto-approved',
    })
    return { success: true }
  })

  // ─── Plan ───
  ipcMain.handle('plan:approve', async (_event, taskId: string, editedSteps?: any[]) => {
    const currentTask = tasksStore.getTask(taskId)
    const steps = editedSteps || currentTask?.steps || []

    // Start execution in background — don't block the IPC response
    executeApprovedPlan(taskId, steps)

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

  // ─── Providers ───
  ipcMain.handle('providers:list', async () => {
    const providers = providersStore.getProvidersSafe()
    const activeId = providersStore.getActiveProviderId()
    return providers.map((p) => ({
      ...p,
      isActive: p.id === activeId,
    }))
  })

  ipcMain.handle('providers:add', async (_event, provider: any) => {
    const config: providersStore.ProviderConfig = {
      id: generateId(),
      name: provider.name,
      type: provider.type,
      baseUrl: provider.baseUrl,
      model: provider.model,
      apiKey: provider.apiKey || undefined,
      customHeaders: provider.customHeaders || undefined,
      fallbackPriority: provider.fallbackPriority,
    }
    providersStore.addProvider(config)

    auditStore.appendAudit({
      skill: 'providers',
      action: 'provider_added',
      params: JSON.stringify({ name: config.name, type: config.type, model: config.model }),
      permission: 'auto-approved',
    })

    return { success: true, provider: { ...config, apiKey: undefined, hasApiKey: !!config.apiKey } }
  })

  ipcMain.handle('providers:remove', async (_event, id: string) => {
    const provider = providersStore.getProviders().find((p) => p.id === id)
    providersStore.removeProvider(id)

    auditStore.appendAudit({
      skill: 'providers',
      action: 'provider_removed',
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

    // Return some default models based on provider type
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

  // ─── Plugins ───
  ipcMain.handle('plugins:list', async () => {
    return pluginsStore.getPlugins()
  })

  ipcMain.handle('plugins:install', async (_event, nameOrPath: string) => {
    const id = generateId()
    pluginsStore.installPlugin({
      id,
      name: nameOrPath.split('/').pop() || nameOrPath,
      version: '1.0.0',
      description: `Plugin installed from ${nameOrPath}`,
      author: 'Community',
      enabled: true,
      type: 'skill',
    })

    auditStore.appendAudit({
      skill: 'plugins',
      action: 'plugin_installed',
      params: JSON.stringify({ source: nameOrPath }),
      permission: 'auto-approved',
    })

    return { success: true, id }
  })

  ipcMain.handle('plugins:toggle', async (_event, id: string, enabled: boolean) => {
    const result = pluginsStore.togglePlugin(id, enabled)
    return { success: result }
  })

  ipcMain.handle('plugins:remove', async (_event, id: string) => {
    const result = pluginsStore.removePlugin(id)
    return { success: result }
  })

  ipcMain.handle('plugins:discover', async () => {
    // Mock MCP discovery — check standard locations
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
            discovered.push({
              id: `mcp-${name}`,
              name: `MCP: ${name}`,
              source: loc,
              config,
            })
          }
        }
      } catch { /* skip invalid files */ }
    }

    return discovered
  })

  // ─── Workflows ───
  ipcMain.handle('workflows:list', async () => {
    return workflowsStore.getWorkflows()
  })

  ipcMain.handle('workflows:run', async (_event, id: string, inputs: any) => {
    const workflow = workflowsStore.getWorkflow(id)
    if (!workflow) return { success: false, error: 'Workflow not found' }

    // Update lastRun
    workflowsStore.saveWorkflow({ ...workflow, lastRun: new Date().toISOString() })

    auditStore.appendAudit({
      skill: 'workflows',
      action: 'workflow_run',
      params: JSON.stringify({ workflowId: id, name: workflow.name, inputs }),
      permission: 'auto-approved',
    })

    // Trigger agent:run with the workflow as a task
    const mainWindow = getMainWindow()
    if (mainWindow) {
      const taskDescription = `Run workflow: ${workflow.name}${workflow.description ? ' — ' + workflow.description : ''}`
      const folder = settingsStore.getSettings().defaultFolder || app.getPath('home')
      mainWindow.webContents.send('workflow:started', { workflowId: id, name: workflow.name })
    }

    return { success: true }
  })

  ipcMain.handle('workflows:save', async (_event, workflow: any) => {
    const toSave: workflowsStore.Workflow = {
      id: workflow.id || generateId(),
      name: workflow.name,
      description: workflow.description || '',
      author: workflow.author || 'User',
      version: workflow.version || '1.0.0',
      inputs: workflow.inputs || [],
      steps: workflow.steps || [],
      createdAt: workflow.createdAt || new Date().toISOString(),
      lastRun: workflow.lastRun,
    }
    workflowsStore.saveWorkflow(toSave)

    auditStore.appendAudit({
      skill: 'workflows',
      action: 'workflow_saved',
      params: JSON.stringify({ id: toSave.id, name: toSave.name }),
      permission: 'auto-approved',
    })

    return { success: true, workflow: toSave }
  })

  ipcMain.handle('workflows:delete', async (_event, id: string) => {
    workflowsStore.deleteWorkflow(id)

    auditStore.appendAudit({
      skill: 'workflows',
      action: 'workflow_deleted',
      params: JSON.stringify({ id }),
      permission: 'auto-approved',
    })

    return { success: true }
  })

  ipcMain.handle('workflows:import', async (_event, filePath?: string) => {
    let targetPath = filePath
    if (!targetPath) {
      const result = await dialog.showOpenDialog({
        title: 'Import Workflow',
        filters: [{ name: 'JSON', extensions: ['json'] }],
        properties: ['openFile'],
      })
      if (result.canceled || result.filePaths.length === 0) return { success: false, error: 'Cancelled' }
      targetPath = result.filePaths[0]
    }

    try {
      const raw = readFileSync(targetPath!, 'utf-8')
      const data = JSON.parse(raw)
      const workflow: workflowsStore.Workflow = {
        id: data.id || generateId(),
        name: data.name || 'Imported Workflow',
        description: data.description || '',
        author: data.author || 'Imported',
        version: data.version || '1.0.0',
        inputs: data.inputs || [],
        steps: data.steps || [],
        createdAt: new Date().toISOString(),
      }
      workflowsStore.saveWorkflow(workflow)
      return { success: true, workflow }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ─── Audit ───
  ipcMain.handle('audit:list', async (_event, filter?: any) => {
    return auditStore.getAuditEntries(filter)
  })

  ipcMain.handle('audit:export', async (_event, format: 'csv' | 'json') => {
    const data = auditStore.exportAudit(format)
    // Offer save dialog
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

  // ─── Tasks ───
  ipcMain.handle('tasks:list', async () => {
    return tasksStore.getTasks()
  })

  ipcMain.handle('tasks:get', async (_event, id: string) => {
    return tasksStore.getTask(id)
  })

  // ─── Settings ───
  ipcMain.handle('settings:get', async () => {
    return settingsStore.getSettings()
  })

  ipcMain.handle('settings:update', async (_event, updates: any) => {
    settingsStore.updateSettings(updates)
    return { success: true }
  })

  // ─── Filesystem ───
  ipcMain.handle('fs:pickFolder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
    })
    return result.canceled ? null : result.filePaths[0]
  })

  // ─── Window controls ───
  ipcMain.handle('window:minimize', async (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })

  ipcMain.handle('window:maximize', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win?.isMaximized()) {
      win.unmaximize()
    } else {
      win?.maximize()
    }
  })

  ipcMain.handle('window:close', async (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })
}
