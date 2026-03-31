import Store from 'electron-store'

export interface WorkflowInput {
  id: string
  label: string
  type: 'string' | 'number' | 'boolean' | 'date' | 'select'
  options?: string[]
  default?: unknown
  required?: boolean
}

export interface WorkflowStep {
  id: string
  title: string
  skill: string
  action?: string
  prompt?: string
  params?: Record<string, unknown>
  input?: string
}

export interface Workflow {
  id: string
  name: string
  description: string
  author: string
  version: string
  inputs: WorkflowInput[]
  steps: WorkflowStep[]
  createdAt: string
  lastRun?: string
}

interface WorkflowsSchema {
  workflows: Workflow[]
}

let _store: Store<WorkflowsSchema> | null = null
function store(): Store<WorkflowsSchema> {
  if (!_store) {
    _store = new Store<WorkflowsSchema>({
      name: 'workflows',
      defaults: { workflows: [] },
    })
  }
  return _store
}

export function getWorkflows(): Workflow[] {
  return store().get('workflows')
}

export function saveWorkflow(workflow: Workflow): void {
  const workflows = getWorkflows()
  const idx = workflows.findIndex((w) => w.id === workflow.id)
  if (idx >= 0) {
    workflows[idx] = workflow
  } else {
    workflows.push(workflow)
  }
  store().set('workflows', workflows)
}

export function deleteWorkflow(id: string): void {
  const workflows = getWorkflows().filter((w) => w.id !== id)
  store().set('workflows', workflows)
}

export function getWorkflow(id: string): Workflow | undefined {
  return getWorkflows().find((w) => w.id === id)
}
