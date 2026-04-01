import { contextBridge, ipcRenderer } from 'electron'

const api = {
  agent: {
    run: (task: string, folderId: string) =>
      ipcRenderer.invoke('agent:run', task, folderId),
    followup: (taskId: string, message: string) =>
      ipcRenderer.invoke('agent:followup', taskId, message),
    cancel: (taskId: string) =>
      ipcRenderer.invoke('agent:cancel', taskId),
    onStep: (cb: (data: any) => void) => {
      const listener = (_: any, s: any) => cb(s)
      ipcRenderer.on('agent:step', listener)
      return () => { ipcRenderer.removeListener('agent:step', listener) }
    },
    onComplete: (cb: (result: any) => void) => {
      const listener = (_: any, r: any) => cb(r)
      ipcRenderer.on('agent:complete', listener)
      return () => { ipcRenderer.removeListener('agent:complete', listener) }
    },
    onPlan: (cb: (plan: any) => void) => {
      const listener = (_: any, p: any) => cb(p)
      ipcRenderer.on('agent:plan', listener)
      return () => { ipcRenderer.removeListener('agent:plan', listener) }
    },
    onStatus: (cb: (data: any) => void) => {
      const listener = (_: any, d: any) => cb(d)
      ipcRenderer.on('agent:status', listener)
      return () => { ipcRenderer.removeListener('agent:status', listener) }
    },
    /** Subscribe to streaming events (text deltas, tool calls, etc.) */
    onStream: (cb: (data: any) => void) => {
      const listener = (_: any, d: any) => cb(d)
      ipcRenderer.on('agent:stream', listener)
      return () => { ipcRenderer.removeListener('agent:stream', listener) }
    },
  },

  plan: {
    approve: (taskId: string, editedSteps?: any[]) =>
      ipcRenderer.invoke('plan:approve', taskId, editedSteps),
    reject: (taskId: string) =>
      ipcRenderer.invoke('plan:reject', taskId),
  },

  permission: {
    onRequest: (cb: (req: any) => void) => {
      const listener = (_: any, r: any) => cb(r)
      ipcRenderer.on('permission:request', listener)
      return () => { ipcRenderer.removeListener('permission:request', listener) }
    },
    respond: (stepId: string, approved: boolean, remember: boolean) =>
      ipcRenderer.invoke('permission:respond', stepId, approved, remember),
  },

  cost: {
    getTask: (taskId: string) => ipcRenderer.invoke('cost:task', taskId),
    getSession: () => ipcRenderer.invoke('cost:session'),
  },

  providers: {
    list: () => ipcRenderer.invoke('providers:list'),
    add: (p: any) => ipcRenderer.invoke('providers:add', p),
    remove: (id: string) => ipcRenderer.invoke('providers:remove', id),
    test: (id: string) => ipcRenderer.invoke('providers:test', id),
    setActive: (id: string) => ipcRenderer.invoke('providers:setActive', id),
    models: (id: string) => ipcRenderer.invoke('providers:models', id),
    getActive: () => ipcRenderer.invoke('providers:getActive'),
  },

  plugins: {
    list: () => ipcRenderer.invoke('plugins:list'),
    install: (pathOrNpm: string) => ipcRenderer.invoke('plugins:install', pathOrNpm),
    toggle: (id: string, enabled: boolean) => ipcRenderer.invoke('plugins:toggle', id, enabled),
    remove: (id: string) => ipcRenderer.invoke('plugins:remove', id),
    discover: () => ipcRenderer.invoke('plugins:discover'),
  },

  workflows: {
    list: () => ipcRenderer.invoke('workflows:list'),
    run: (id: string, inputs: object) => ipcRenderer.invoke('workflows:run', id, inputs),
    save: (w: any) => ipcRenderer.invoke('workflows:save', w),
    delete: (id: string) => ipcRenderer.invoke('workflows:delete', id),
    import: (filePath?: string) => ipcRenderer.invoke('workflows:import', filePath),
  },

  audit: {
    list: (filter?: any) => ipcRenderer.invoke('audit:list', filter),
    export: (format: 'csv' | 'json') => ipcRenderer.invoke('audit:export', format),
  },

  tasks: {
    list: () => ipcRenderer.invoke('tasks:list'),
    get: (id: string) => ipcRenderer.invoke('tasks:get', id),
  },

  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (updates: any) => ipcRenderer.invoke('settings:update', updates),
  },

  fs: {
    pickFolder: () => ipcRenderer.invoke('fs:pickFolder'),
  },

  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
  },
}

contextBridge.exposeInMainWorld('wispyr', api)

export type WispyrAPI = typeof api
