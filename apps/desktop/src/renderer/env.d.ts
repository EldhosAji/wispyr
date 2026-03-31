/// <reference types="vite/client" />

interface WispyrAPI {
  agent: {
    run: (task: string, folderId: string) => Promise<any>
    cancel: (taskId: string) => Promise<any>
    onStep: (cb: (data: any) => void) => () => void
    onComplete: (cb: (result: any) => void) => () => void
    onPlan: (cb: (plan: any) => void) => () => void
    onStatus: (cb: (data: any) => void) => () => void
  }
  plan: {
    approve: (taskId: string, editedSteps?: any[]) => Promise<any>
    reject: (taskId: string) => Promise<any>
  }
  permission: {
    onRequest: (cb: (req: any) => void) => () => void
    respond: (stepId: string, approved: boolean, remember: boolean) => Promise<any>
  }
  providers: {
    list: () => Promise<any[]>
    add: (p: any) => Promise<any>
    remove: (id: string) => Promise<any>
    test: (id: string) => Promise<any>
    setActive: (id: string) => Promise<any>
    models: (id: string) => Promise<string[]>
    getActive: () => Promise<any>
  }
  plugins: {
    list: () => Promise<any[]>
    install: (pathOrNpm: string) => Promise<any>
    toggle: (id: string, enabled: boolean) => Promise<any>
    remove: (id: string) => Promise<any>
    discover: () => Promise<any[]>
  }
  workflows: {
    list: () => Promise<any[]>
    run: (id: string, inputs: object) => Promise<any>
    save: (w: any) => Promise<any>
    delete: (id: string) => Promise<any>
    import: (filePath?: string) => Promise<any>
  }
  audit: {
    list: (filter?: any) => Promise<any[]>
    export: (format: 'csv' | 'json') => Promise<any>
  }
  tasks: {
    list: () => Promise<any[]>
    get: (id: string) => Promise<any>
  }
  settings: {
    get: () => Promise<any>
    update: (updates: any) => Promise<any>
  }
  fs: {
    pickFolder: () => Promise<string | null>
  }
  window: {
    minimize: () => Promise<void>
    maximize: () => Promise<void>
    close: () => Promise<void>
  }
}

declare global {
  interface Window {
    wispyr: WispyrAPI
  }
}

export {}
